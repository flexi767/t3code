// @effect-diagnostics nodeBuiltinImport:off - inject a short write into an actual temporary attachment file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { publishMoveFile } from "./ThreadMoveService.ts";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

it("keeps partial writes out of final attachment names and safely retries publication", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-move-files-"));
  const path = NodePath.join(directory, "attachment.bin");
  const bytes = Buffer.from("complete attachment bytes");
  try {
    const { writeFileSync: write } = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(NodeFS.writeFileSync)
      .mockReset()
      .mockImplementation(write)
      .mockImplementationOnce((file, _data, options) => {
        write(file, Buffer.from("partial"), options);
        throw new Error("Simulated disk exhaustion");
      });
    assert.throws(() => publishMoveFile(path, bytes), "Simulated disk exhaustion");
    assert.isFalse(NodeFS.existsSync(path));
    assert.deepEqual(NodeFS.readdirSync(directory), []);
    publishMoveFile(path, bytes);
    publishMoveFile(path, bytes);
    assert.deepEqual(NodeFS.readFileSync(path), bytes);
    assert.throws(() => publishMoveFile(path, Buffer.from("different")), "does not match");
    assert.deepEqual(NodeFS.readFileSync(path), bytes);
    assert.deepEqual(NodeFS.readdirSync(directory), ["attachment.bin"]);
    const cleanupPath = NodePath.join(directory, "cleanup.bin");
    vi.mocked(NodeFS.writeFileSync).mockImplementationOnce((file, _data, options) => {
      write(file, Buffer.from("partial"), options);
      throw new Error("Primary write failure");
    });
    vi.mocked(NodeFS.unlinkSync).mockImplementationOnce(() => {
      throw new Error("Secondary cleanup failure");
    });
    assert.throws(() => publishMoveFile(cleanupPath, bytes), "Primary write failure");
    assert.isFalse(NodeFS.existsSync(cleanupPath));
    publishMoveFile(cleanupPath, bytes);
    assert.deepEqual(NodeFS.readFileSync(cleanupPath), bytes);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
