-- Install only in the dedicated t3_agent_coordination database, as its owner.
BEGIN;
CREATE SCHEMA IF NOT EXISTS agent_coordination;
CREATE SEQUENCE IF NOT EXISTS agent_coordination.lease_generation;
CREATE TABLE IF NOT EXISTS agent_coordination.package_leases (
  repository text NOT NULL,
  package text NOT NULL,
  lease_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL,
  owner text NOT NULL,
  host text NOT NULL,
  worktree text NOT NULL,
  summary text NOT NULL,
  claimed_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (repository, package)
);

CREATE OR REPLACE FUNCTION agent_coordination.lease(request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, agent_coordination, pg_temp AS $$
DECLARE
  action text := request->>'action';
  repo text := request->>'repository';
  scope text := request->>'package';
  actor text := request->>'owner';
  ttl integer := coalesce((request->>'ttlSeconds')::integer, 900);
  current_time_at_lock timestamptz;
  conflicts jsonb;
  result agent_coordination.package_leases;
BEGIN
  IF repo IS NULL OR repo !~ '^[a-z0-9][a-z0-9._/-]{0,199}$'
     OR repo ~ '(^|/)\.\.?(/|$)' THEN
    RAISE EXCEPTION 'repository must be a canonical lowercase repository identifier';
  END IF;
  IF action NOT IN ('list', 'claim', 'renew', 'release') OR action IS NULL THEN
    RAISE EXCEPTION 'action must be list, claim, renew or release';
  END IF;
  IF scope IS NOT NULL AND (scope = '' OR length(scope) > 300
     OR (scope <> '.' AND (scope !~ '^[a-zA-Z0-9_@.-]+(/[a-zA-Z0-9_@.-]+)*$'
       OR scope ~ '(^|/)\.\.?(/|$)'))) THEN
    RAISE EXCEPTION 'package must be a relative path or . for the whole repository';
  END IF;
  IF action = 'list' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.package), '[]'::jsonb)
      INTO conflicts FROM agent_coordination.package_leases l
      WHERE l.repository = repo AND l.expires_at > clock_timestamp()
        AND l.released_at IS NULL;
    RETURN jsonb_build_object('status', 'listed', 'leases', conflicts);
  END IF;
  IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'owner is required (use a stable thread or session id)';
  END IF;
  IF ttl NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'ttlSeconds must be between 30 and 3600';
  END IF;
  -- All overlapping path decisions for a repository share one transaction lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(repo, 0));
  current_time_at_lock := clock_timestamp();
  IF action = 'claim' THEN
    IF scope IS NULL OR coalesce(length(request->>'host'), 0) NOT BETWEEN 1 AND 200
       OR coalesce(length(request->>'worktree'), 0) NOT BETWEEN 1 AND 1000
       OR coalesce(length(request->>'summary'), 0) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'claim requires package, host, worktree and summary';
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.package), '[]'::jsonb)
      INTO conflicts FROM agent_coordination.package_leases l
      WHERE l.repository = repo AND l.released_at IS NULL
        AND l.expires_at > current_time_at_lock
        AND (l.package = scope OR scope = '.' OR l.package = '.'
          OR starts_with(l.package, scope || '/') OR starts_with(scope, l.package || '/'));
    IF jsonb_array_length(conflicts) > 0 THEN
      RETURN jsonb_build_object('status', 'conflict', 'leases', conflicts);
    END IF;
    INSERT INTO agent_coordination.package_leases AS l
      (repository, package, lease_id, generation, owner, host, worktree, summary,
       claimed_at, renewed_at, expires_at, released_at)
    VALUES (repo, scope, gen_random_uuid(), nextval('agent_coordination.lease_generation'),
      actor, request->>'host', request->>'worktree', request->>'summary',
      current_time_at_lock, current_time_at_lock,
      current_time_at_lock + make_interval(secs => ttl), NULL)
    ON CONFLICT (repository, package) DO UPDATE SET
      lease_id = excluded.lease_id, generation = excluded.generation, owner = excluded.owner,
      host = excluded.host, worktree = excluded.worktree, summary = excluded.summary,
      claimed_at = excluded.claimed_at, renewed_at = excluded.renewed_at,
      expires_at = excluded.expires_at, released_at = NULL
    RETURNING l.* INTO result;
  ELSE
    UPDATE agent_coordination.package_leases l SET
      renewed_at = CASE WHEN action = 'renew' THEN current_time_at_lock ELSE l.renewed_at END,
      expires_at = CASE WHEN action = 'renew'
        THEN current_time_at_lock + make_interval(secs => ttl) ELSE current_time_at_lock END,
      released_at = CASE WHEN action = 'release' THEN current_time_at_lock ELSE NULL END
    WHERE l.repository = repo AND l.lease_id = (request->>'leaseId')::uuid
      AND l.owner = actor AND l.generation = (request->>'generation')::bigint
      AND l.released_at IS NULL AND l.expires_at > current_time_at_lock
    RETURNING l.* INTO result;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'lost', 'message', 'Lease expired, replaced or not owned by caller; stop editing and claim again.');
    END IF;
  END IF;
  RETURN jsonb_build_object('status', CASE action WHEN 'claim' THEN 'claimed'
    WHEN 'renew' THEN 'renewed' ELSE 'released' END, 'lease', to_jsonb(result));
END;
$$;
REVOKE ALL ON SCHEMA agent_coordination FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_coordination.lease(jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA agent_coordination TO ubuntu;
GRANT EXECUTE ON FUNCTION agent_coordination.lease(jsonb) TO ubuntu;
COMMIT;
