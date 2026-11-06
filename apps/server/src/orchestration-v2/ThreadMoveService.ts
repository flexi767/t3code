// @effect-diagnostics nodeBuiltinImport:off - portable attachment files are copied atomically inside the configured attachment root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ThreadId,
  ThreadMoveError,
  type ProjectId,
  type ThreadMoveBundle,
  type ThreadMoveImportInput,
  type ThreadMoveReceipt,
  ThreadMoveExportInput,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  attachmentRelativePath,
  createDeterministicAttachmentId,
  resolveAttachmentPathById,
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Projects from "./ProjectStore.ts";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  assertMoveIdle,
  localMoveProjection,
  movedToolAssetIds,
  importedMoveProjections,
  movedId,
  moveDigest,
  moveProjectionEvents,
  validateMoveBundle,
  THREAD_MOVE_MAX_BYTES,
  type MoveCheckout,
} from "./threadMove.ts";

type ExportInput = typeof ThreadMoveExportInput.Type;

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly export: (input: ExportInput) => Effect.Effect<ThreadMoveBundle, ThreadMoveError>;
    readonly receive: (
      input: ThreadMoveImportInput,
    ) => Effect.Effect<ThreadMoveReceipt, ThreadMoveError>;
    readonly finish: (
      input: ThreadMoveReceipt,
    ) => Effect.Effect<ThreadMoveReceipt, ThreadMoveError>;
  }
>()("t3/orchestration-v2/ThreadMoveService") {}

const isMoveError = Schema.is(ThreadMoveError);
const encodePreparation = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      digest: Schema.String,
      projectId: Schema.String,
      repository: Schema.String,
      path: Schema.String,
      branch: Schema.String,
      commit: Schema.String,
    }),
  ),
);
const failed = (message: string) =>
  Effect.mapError((error: unknown) =>
    isMoveError(error) ? error : new ThreadMoveError({ message }),
  );
const attempt = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (error) =>
      isMoveError(error)
        ? error
        : new ThreadMoveError({ message: "Could not read or write a transfer attachment." }),
  });

function safeAssetPath(root: string, relative: string): string {
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+){1,3}$/i.test(relative) || relative.length > 240) {
    throw new ThreadMoveError({ message: "Invalid transfer attachment path." });
  }
  const path = NodePath.join(root, relative);
  if (
    NodeFS.existsSync(path) &&
    (NodeFS.lstatSync(path).isSymbolicLink() || !NodeFS.statSync(path).isFile())
  ) {
    throw new ThreadMoveError({ message: "Transfer attachments must be regular files." });
  }
  return path;
}

export function publishMoveFile(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.part`;
  try {
    const fd = NodeFS.openSync(temporary, "wx", 0o600);
    try {
      NodeFS.writeFileSync(fd, bytes);
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    try {
      NodeFS.linkSync(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const stat = NodeFS.lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !NodeFS.readFileSync(path).equals(Buffer.from(bytes))
      ) {
        throw new ThreadMoveError({
          message: "A previous transfer file does not match this snapshot. Start a new move.",
        });
      }
    }
  } finally {
    try {
      if (NodeFS.existsSync(temporary)) NodeFS.unlinkSync(temporary);
    } catch {
      /* A stale temporary file must not mask the primary publication error. */
    }
  }
}

function relatedThreadIds(projection: OrchestrationV2ThreadProjection): ReadonlyArray<ThreadId> {
  return [
    ...new Set(
      [
        projection.thread.lineage.parentThreadId,
        projection.thread.forkedFrom?.type === "run" ? projection.thread.forkedFrom.threadId : null,
        ...projection.contextTransfers.map((transfer) => transfer.sourceThreadId),
      ].filter((id): id is ThreadId => id !== null && id !== projection.thread.id),
    ),
  ];
}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectStoreV2;
  const store = yield* EventStore.EventStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const git = yield* GitWorkflow.GitWorkflowService;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const config = yield* ServerConfig.ServerConfig;

  const project = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      failed("Could not read the project."),
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null && row.value.archivedAt === null
          ? Effect.succeed(row.value)
          : Effect.fail(new ThreadMoveError({ message: "Choose an active destination project." })),
      ),
    );

  const exportThread = Effect.fn("ThreadMove.export")(function* (input: ExportInput) {
    const selected = new Set<ThreadId>([input.threadId]);
    const selectedQueue = [input.threadId];
    for (const id of selectedQueue) {
      const current = yield* threads
        .getThreadProjection(id)
        .pipe(failed("Could not read side chats."));
      if (id !== input.threadId && current.thread.deletedAt !== null) continue;
      for (const transfer of current.contextTransfers) {
        if (
          transfer.type !== "fork" ||
          transfer.sourceThreadId !== id ||
          selected.has(transfer.targetThreadId)
        )
          continue;
        const childShell = yield* threads
          .getThreadShell(transfer.targetThreadId)
          .pipe(failed("Could not read side chats."));
        if (childShell === null) continue;
        const child = yield* threads
          .getThreadProjection(transfer.targetThreadId)
          .pipe(failed("Could not read side chats."));
        if (child.thread.lineage.sideChat === true && child.thread.deletedAt === null) {
          selected.add(child.thread.id);
          selectedQueue.push(child.thread.id);
        }
      }
      for (const child of yield* threads
        .listAppOwnedChildThreadIds(id)
        .pipe(failed("Could not read subthreads."))) {
        if (!selected.has(child)) {
          const shell = yield* threads
            .getThreadShell(child)
            .pipe(failed("Could not inspect subthread state."));
          if (shell === null || shell.deletedAt !== null) continue;
          selected.add(child);
          selectedQueue.push(child);
        }
      }
    }
    const projections: ThreadMoveBundle["projections"][number][] = [];
    for (const id of selected) {
      const projection = yield* threads
        .getThreadProjection(id)
        .pipe(failed("Could not inspect source work."));
      if (
        id !== input.threadId &&
        (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
      )
        continue;
      yield* attempt(() => assertMoveIdle(projection));
    }
    const prepared = new Set<string>();
    const seen = new Set<ThreadId>();
    const queue = [...selected];
    for (const id of queue) {
      if (seen.has(id)) continue;
      seen.add(id);
      yield* threads.ensureLegacyTranscript(id).pipe(failed("Could not load saved history."));
      const snapshot = yield* threads
        .getThreadSnapshot(id)
        .pipe(failed("Could not export the full thread."));
      const { snapshotSequence } = snapshot;
      const projection = localMoveProjection(snapshot.projection);
      if (selected.has(id) && id !== input.threadId && projection.thread.deletedAt !== null)
        continue;
      if (!selected.has(id) || (id !== input.threadId && projection.thread.archivedAt !== null)) {
        projections.push({ projection, sequence: snapshotSequence, move: false, commitSha: null });
        for (const reference of relatedThreadIds(projection))
          if (!seen.has(reference)) queue.push(reference);
        continue;
      }
      yield* attempt(() => assertMoveIdle(projection));
      const row = yield* project(projection.thread.projectId);
      const cwd = projection.thread.worktreePath ?? row.workspaceRoot;
      let status = yield* git
        .localStatus({ cwd, includeCheckoutDetails: true })
        .pipe(failed("Could not inspect the source checkout."));
      if (input.prepareRepository && status.isRepo && !prepared.has(cwd)) {
        if (!status.refName)
          return yield* new ThreadMoveError({
            message: "Choose a branch before moving this checkout.",
          });
        const peers = yield* threads
          .listProjectThreads({ includeSubagents: true })
          .pipe(failed("Could not inspect other active threads."));
        for (const peer of peers) {
          if (peer.activeRunId === null || selected.has(peer.id)) continue;
          const peerProject = yield* project(peer.projectId);
          if (
            NodePath.resolve(peer.worktreePath ?? peerProject.workspaceRoot) ===
            NodePath.resolve(cwd)
          )
            return yield* new ThreadMoveError({
              message: "Another thread is working in this checkout. Finish it before moving.",
            });
        }
        if (status.hasWorkingTreeChanges)
          yield* driver
            .commit(cwd, "chore: save work before moving thread", "", { stage: {} })
            .pipe(
              failed(
                "Could not commit checkout changes. Resolve Git conflicts or failing hooks, then retry the move.",
              ),
            );
        yield* driver
          .pushCurrentBranch(cwd, status.refName, { remoteName: "origin" })
          .pipe(
            failed(
              "Could not push to origin. Any local commit is kept; check Git access or branch divergence, then retry.",
            ),
          );
        status = yield* git
          .localStatus({ cwd, includeCheckoutDetails: true })
          .pipe(failed("Could not verify the prepared checkout."));
        prepared.add(cwd);
      }
      if (selected.has(id) && status.hasWorkingTreeChanges) {
        return yield* new ThreadMoveError({
          message:
            "Commit the thread's working-tree changes before moving it. Working files are not copied between machines.",
        });
      }
      const commitSha = status.isRepo
        ? (yield* driver
            .resolveCommit({ cwd, revision: "HEAD" })
            .pipe(failed("Could not resolve the source commit."))).commitSha
        : null;
      projections.push({
        projection,
        sequence: snapshotSequence,
        move: selected.has(id),
        commitSha,
      });
      for (const reference of relatedThreadIds(projection))
        if (!seen.has(reference)) queue.push(reference);
    }
    const assets = yield* attempt(() => {
      const paths = new Set<string>();
      for (const { projection } of projections) {
        for (const message of projection.messages)
          for (const attachment of message.attachments) {
            const path = attachmentRelativePath(attachment);
            if (path !== null) paths.add(path);
          }
        // Render and recording tools refer to saved assets outside message.attachments.
        const visit = (value: unknown): void => {
          if (typeof value === "string" && parseAttachmentUuid(value) !== null) {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: value,
            });
            if (path !== null) paths.add(NodePath.basename(path));
          } else if (Array.isArray(value)) value.forEach(visit);
          else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
        };
        projection.turnItems.forEach(visit);
        for (const item of projection.turnItems) {
          if (item.type !== "dynamic_tool") continue;
          for (const id of movedToolAssetIds(item)) {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: id,
            });
            if (path === null)
              throw new ThreadMoveError({
                message: "A saved render or recording is missing on the source machine.",
              });
            paths.add(NodePath.basename(path));
          }
        }
      }
      let bytes = 0;
      return [...paths].map((path) => {
        const file = safeAssetPath(config.attachmentsDir, path);
        if (!NodeFS.existsSync(file))
          throw new ThreadMoveError({
            message:
              "A saved attachment is missing on the source machine. Restore it before moving this thread.",
          });
        bytes += NodeFS.statSync(file).size;
        if (bytes > THREAD_MOVE_MAX_BYTES)
          throw new ThreadMoveError({
            message: "This thread's attachments exceed the 32 MB move limit.",
          });
        return { path, data: NodeFS.readFileSync(file).toString("base64") };
      });
    });
    const bundle = {
      version: 1 as const,
      transferId: input.transferId,
      sourceThreadId: input.threadId,
      sourceEnvironmentId: environmentId,
      projections,
      assets,
    };
    yield* attempt(() => validateMoveBundle(bundle));
    return bundle;
  });

  const receive = Effect.fn("ThreadMove.receive")(function* ({
    projectId,
    bundle,
  }: ThreadMoveImportInput) {
    yield* attempt(() => validateMoveBundle(bundle));
    yield* attempt(() => {
      let bytes = 0;
      for (const asset of bundle.assets) {
        safeAssetPath(config.attachmentsDir, asset.path);
        if (parseAttachmentUuid(asset.path.slice(0, asset.path.indexOf("."))) === null)
          throw new ThreadMoveError({ message: "Invalid attachment identity." });
        const data = Buffer.from(asset.data, "base64");
        if (data.toString("base64") !== asset.data)
          throw new ThreadMoveError({ message: "Invalid attachment encoding." });
        bytes += data.length;
        if (bytes > THREAD_MOVE_MAX_BYTES)
          throw new ThreadMoveError({ message: "Transfer attachments exceed 32 MB." });
      }
    });
    if (
      bundle.sourceEnvironmentId === environmentId ||
      !bundle.projections.some(
        (entry) => entry.move && entry.projection.thread.id === bundle.sourceThreadId,
      )
    ) {
      return yield* new ThreadMoveError({
        message: "Choose another machine and a valid source thread.",
      });
    }
    const destination = yield* project(projectId);
    const digest = yield* attempt(() => moveDigest(bundle));
    const targetId = ThreadId.make(movedId(bundle.transferId, bundle.sourceThreadId));
    const receipt: ThreadMoveReceipt = {
      transferId: bundle.transferId,
      sourceEnvironmentId: bundle.sourceEnvironmentId,
      sourceThreadId: bundle.sourceThreadId,
      destinationEnvironmentId: environmentId,
      destinationThreadId: targetId,
      destinationProjectId: projectId,
      digest,
      sources: bundle.projections
        .filter((entry) => entry.move)
        .map((entry) => ({ threadId: entry.projection.thread.id, sequence: entry.sequence })),
    };
    return yield* executor.withLock(
      targetId,
      Effect.gen(function* () {
        const previous = yield* threads
          .getThreadShell(targetId)
          .pipe(failed("Could not check a previous transfer."));
        if (previous !== null) {
          const creation = yield* store
            .read({ threadId: targetId, eventType: "thread.created", limit: 1 })
            .pipe(Stream.runCollect, failed("Could not verify the previous transfer."));
          if (
            previous.projectId !== projectId ||
            !creation[0]?.event.id.startsWith(`thread-move:${bundle.transferId}:${digest}:`)
          ) {
            return yield* new ThreadMoveError({
              message:
                "This move ID was already used for a different snapshot or project. Start a new move.",
            });
          }
          return receipt;
        }
        const checkouts = new Map<string, MoveCheckout>();
        const created: { path: string; branch: string; commit: string }[] = [];
        const committed = { value: false };
        return yield* Effect.gen(function* () {
          for (const entry of bundle.projections) {
            if (entry.move) yield* attempt(() => assertMoveIdle(entry.projection));
            const enabled = yield* threads.isProviderInstanceEnabledForProject({
              projectId,
              instanceId: entry.projection.thread.providerInstanceId,
            });
            if (entry.move && !enabled)
              return yield* new ThreadMoveError({
                message: `Enable provider ${entry.projection.thread.providerInstanceId} in the destination project before moving.`,
              });
            if (!entry.move || entry.commitSha === null) {
              checkouts.set(entry.projection.thread.id, {
                path: destination.workspaceRoot,
                branch: null,
              });
              continue;
            }
            if (!/^[a-f0-9]{40,64}$/i.test(entry.commitSha))
              return yield* new ThreadMoveError({ message: "Invalid source commit." });
            const available = yield* git
              .hasCommit({ cwd: destination.workspaceRoot, refName: entry.commitSha })
              .pipe(failed("Could not inspect the destination repository."));
            if (!available)
              yield* git
                .fetchRemote({ cwd: destination.workspaceRoot, remoteName: "origin" })
                .pipe(
                  failed("Could not fetch the destination repository. Check its Git credentials."),
                );
            if (
              !(yield* git
                .hasCommit({ cwd: destination.workspaceRoot, refName: entry.commitSha })
                .pipe(failed("Could not inspect the destination commit.")))
            ) {
              return yield* new ThreadMoveError({
                message:
                  "The source commit is not available on the destination. Push its branch first, then retry.",
              });
            }
            const movedThread = movedId(bundle.transferId, entry.projection.thread.id);
            const branch = `t3-move-${bundle.transferId}-${movedThread}`;
            const path = NodePath.join(config.worktreesDir, "thread-move", movedThread);
            const intent = NodePath.join(
              config.stateDir,
              "thread-moves",
              bundle.transferId,
              `${movedThread}.json`,
            );
            const ownership = Buffer.from(
              encodePreparation({
                digest,
                projectId,
                repository: destination.workspaceRoot,
                path,
                branch,
                commit: entry.commitSha,
              }),
            );
            const branchExists = (yield* git
              .listLocalBranchNames(destination.workspaceRoot)
              .pipe(failed("Could not inspect prepared branches."))).includes(branch);
            const pathStat = yield* attempt(() =>
              NodeFS.lstatSync(path, { throwIfNoEntry: false }),
            );
            const ownsPreparation = yield* attempt(() => {
              if (NodeFS.existsSync(intent)) {
                const stat = NodeFS.lstatSync(intent);
                if (
                  stat.isSymbolicLink() ||
                  !stat.isFile() ||
                  !NodeFS.readFileSync(intent).equals(ownership)
                )
                  throw new ThreadMoveError({
                    message:
                      "This move's preparation belongs to a different snapshot or project. Start a new move.",
                  });
                return true;
              }
              if (branchExists || pathStat !== undefined)
                throw new ThreadMoveError({
                  message:
                    "The destination checkout already exists without this move's ownership record. Start a new move.",
                });
              NodeFS.mkdirSync(NodePath.dirname(intent), { recursive: true });
              NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
              publishMoveFile(intent, ownership);
              return false;
            });
            if (ownsPreparation && pathStat !== undefined) {
              if (!pathStat.isDirectory() || pathStat.isSymbolicLink())
                return yield* new ThreadMoveError({
                  message: "The prepared checkout is not a regular directory.",
                });
              const registered = yield* driver
                .listWorktreePaths(destination.workspaceRoot)
                .pipe(failed("Could not verify the prepared worktree."));
              const status = yield* git
                .localStatus({ cwd: path })
                .pipe(failed("Could not verify the prepared checkout."));
              const commit = yield* driver
                .resolveCommit({ cwd: path, revision: "HEAD" })
                .pipe(failed("Could not verify the prepared commit."));
              const common = (cwd: string) =>
                driver
                  .execute({
                    cwd,
                    operation: "ThreadMove.verifyRepository",
                    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                  })
                  .pipe(
                    Effect.map((result) => NodePath.resolve(result.stdout.trim())),
                    failed("Could not verify repository ownership."),
                  );
              if (
                !registered.includes(path) ||
                !status.isRepo ||
                status.hasWorkingTreeChanges ||
                status.refName !== branch ||
                commit.commitSha !== entry.commitSha ||
                (yield* common(path)) !== (yield* common(destination.workspaceRoot))
              ) {
                return yield* new ThreadMoveError({
                  message:
                    "The prepared checkout changed or is incomplete. Keep its files and review it before retrying this move.",
                });
              }
              created.push({ path, branch, commit: entry.commitSha });
              checkouts.set(entry.projection.thread.id, { path, branch });
              continue;
            }
            if (branchExists) {
              const commit = yield* driver
                .resolveCommit({ cwd: destination.workspaceRoot, revision: branch })
                .pipe(failed("Could not verify the prepared branch."));
              if (commit.commitSha !== entry.commitSha)
                return yield* new ThreadMoveError({
                  message: "The prepared branch changed. Keep it and start a new move.",
                });
              const registered = yield* driver
                .listWorktreePaths(destination.workspaceRoot)
                .pipe(failed("Could not inspect worktree registration."));
              if (registered.includes(path))
                yield* git
                  .removeWorktree({ cwd: destination.workspaceRoot, path, force: true })
                  .pipe(failed("Could not clear this move's missing worktree registration."));
            }
            const checkout = yield* git
              .createWorktree({
                cwd: destination.workspaceRoot,
                refName: branchExists ? branch : entry.commitSha,
                ...(branchExists ? {} : { newRefName: branch }),
                path,
              })
              .pipe(failed("Could not prepare the destination worktree."));
            created.push({ path: checkout.worktree.path, branch, commit: entry.commitSha });
            checkouts.set(entry.projection.thread.id, {
              path: checkout.worktree.path,
              branch: checkout.worktree.refName,
            });
          }
          const assetIds = new Map<string, string>();
          yield* attempt(() => {
            let bytes = 0;
            for (const asset of bundle.assets) {
              safeAssetPath(config.attachmentsDir, asset.path);
              const separator = asset.path.indexOf(".");
              const oldId = asset.path.slice(0, separator);
              const segment = parseThreadSegmentFromAttachmentId(oldId);
              const owner =
                bundle.projections.find(
                  (entry) => toSafeThreadAttachmentSegment(entry.projection.thread.id) === segment,
                )?.projection.thread.id ?? bundle.sourceThreadId;
              const baseId = createDeterministicAttachmentId(
                movedId(bundle.transferId, owner),
                `${bundle.transferId}:${oldId}`,
              );
              if (baseId === null || parseAttachmentUuid(oldId) === null)
                throw new ThreadMoveError({ message: "Invalid attachment identity." });
              const extension = parseAttachmentFileExtension(oldId);
              const id = extension === null ? baseId : `${baseId}-${extension}`;
              const data = Buffer.from(asset.data, "base64");
              if (data.toString("base64") !== asset.data)
                throw new ThreadMoveError({ message: "Invalid attachment encoding." });
              bytes += data.length;
              if (bytes > THREAD_MOVE_MAX_BYTES)
                throw new ThreadMoveError({ message: "Transfer attachments exceed 32 MB." });
              assetIds.set(oldId, id);
              const path = safeAssetPath(
                config.attachmentsDir,
                `${id}${asset.path.slice(separator)}`,
              );
              publishMoveFile(path, data);
            }
          });
          const now = yield* DateTime.now;
          const projections = yield* attempt(() =>
            importedMoveProjections(bundle, projectId, checkouts, assetIds, now),
          );
          const events = yield* attempt(() =>
            moveProjectionEvents(projections, bundle.transferId, digest),
          );
          // All records commit together. Event replay builds projections but starts no provider effects.
          yield* sink.write({ events }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed.value = true;
              }),
            ),
            Effect.uninterruptible,
            failed("Could not commit the destination history. The source is unchanged."),
          );
          return receipt;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (!committed.value)
                for (const checkout of created) {
                  yield* Effect.gen(function* () {
                    yield* git.removeWorktree({
                      cwd: destination.workspaceRoot,
                      path: checkout.path,
                      force: false,
                    });
                    const current = yield* driver.resolveCommit({
                      cwd: destination.workspaceRoot,
                      revision: checkout.branch,
                    });
                    if (current.commitSha === checkout.commit)
                      yield* git.deleteLocalBranch({
                        cwd: destination.workspaceRoot,
                        refName: checkout.branch,
                        force: true,
                      });
                  }).pipe(Effect.ignore);
                }
            }),
          ),
        );
      }),
    );
  });

  const finish = Effect.fn("ThreadMove.finish")(function* (receipt: ThreadMoveReceipt) {
    if (
      receipt.sourceEnvironmentId !== environmentId ||
      receipt.destinationEnvironmentId === environmentId
    ) {
      return yield* new ThreadMoveError({
        message: "The transfer receipt belongs to another environment.",
      });
    }
    const sourceRoot = receipt.sources.find((entry) => entry.threadId === receipt.sourceThreadId);
    if (sourceRoot === undefined)
      return yield* new ThreadMoveError({
        message: "The transfer receipt does not contain the source thread.",
      });
    const commandId = CommandId.make(
      `thread-move:archive:${receipt.sourceThreadId}:${receipt.transferId}`,
    );
    yield* threads
      .dispatch({
        type: "thread.archive",
        commandId,
        threadId: receipt.sourceThreadId,
        expectedMoveSources: receipt.sources,
      })
      .pipe(
        failed(
          "The destination copy is saved; the source changed or could not be archived and has been kept.",
        ),
      );
    return receipt;
  });
  return ThreadMoveService.of({ export: exportThread, receive, finish });
});

export const layer = Layer.effect(ThreadMoveService, make);
