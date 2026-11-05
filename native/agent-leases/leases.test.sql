-- Run as database owner in an isolated database containing schema.sql. Leaves no test rows.
BEGIN;
DO $$
DECLARE
  base jsonb := '{"repository":"test/rollback","owner":"agent-a","host":"m5","worktree":"/test","summary":"behavior test"}';
  first_lease jsonb;
  second_lease jsonb;
  response jsonb;
  path text;
BEGIN
  first_lease := agent_coordination.lease(base || '{"action":"claim","package":"packages/api"}');
  ASSERT first_lease->>'status' = 'claimed';
  FOREACH path IN ARRAY ARRAY['packages/api', 'packages/api/src', 'packages', '.'] LOOP
    response := agent_coordination.lease(base || jsonb_build_object('action','claim','package',path,'owner','agent-b'));
    ASSERT response->>'status' = 'conflict', path;
    ASSERT response#>>'{leases,0,owner}' = 'agent-a';
  END LOOP;
  response := agent_coordination.lease(base || '{"action":"claim","package":"packages/apix"}');
  ASSERT response->>'status' = 'claimed', 'path prefixes must not overlap sibling packages';
  response := agent_coordination.lease(base || '{"action":"claim","package":".","repository":"test/other"}');
  ASSERT response->>'status' = 'claimed', 'repositories are independent';
  response := agent_coordination.lease(base || jsonb_build_object('action','renew','owner','agent-b',
    'leaseId',first_lease#>>'{lease,lease_id}','generation',first_lease#>'{lease,generation}'));
  ASSERT response->>'status' = 'lost', 'another owner cannot renew';
  response := agent_coordination.lease(base || jsonb_build_object('action','release',
    'leaseId',first_lease#>>'{lease,lease_id}','generation',0));
  ASSERT response->>'status' = 'lost', 'a stale generation cannot release';
  response := agent_coordination.lease(base || jsonb_build_object('action','renew','ttlSeconds',1800,
    'leaseId',first_lease#>>'{lease,lease_id}','generation',first_lease#>'{lease,generation}'));
  ASSERT response->>'status' = 'renewed';
  ASSERT (response#>>'{lease,expires_at}')::timestamptz > (first_lease#>>'{lease,expires_at}')::timestamptz;
  UPDATE agent_coordination.package_leases SET expires_at = clock_timestamp() - interval '1 second'
    WHERE repository = 'test/rollback' AND package = 'packages/api';
  response := agent_coordination.lease(base || jsonb_build_object('action','renew',
    'leaseId',first_lease#>>'{lease,lease_id}','generation',first_lease#>'{lease,generation}'));
  ASSERT response->>'status' = 'lost', 'expired leases cannot be revived';
  response := agent_coordination.lease(base || '{"action":"list"}');
  ASSERT jsonb_array_length(response->'leases') = 1, 'list hides expired leases';
  second_lease := agent_coordination.lease(base || '{"action":"claim","package":"packages/api","owner":"agent-b"}');
  ASSERT second_lease->>'status' = 'claimed';
  ASSERT (second_lease#>>'{lease,generation}')::bigint > (first_lease#>>'{lease,generation}')::bigint;
  response := agent_coordination.lease(base || jsonb_build_object('action','release',
    'leaseId',first_lease#>>'{lease,lease_id}','generation',first_lease#>'{lease,generation}'));
  ASSERT response->>'status' = 'lost', 'old lease cannot release its replacement';
  response := agent_coordination.lease(base || jsonb_build_object('action','release','owner','agent-b',
    'leaseId',second_lease#>>'{lease,lease_id}','generation',second_lease#>'{lease,generation}'));
  ASSERT response->>'status' = 'released';
  response := agent_coordination.lease(base || '{"action":"claim","package":"packages/api/src"}');
  ASSERT response->>'status' = 'claimed', 'released ancestor no longer conflicts';
  response := agent_coordination.lease(base || '{"action":"claim","package":"packages/api"}');
  ASSERT response->>'status' = 'conflict', 'active descendant conflicts with ancestor';
  FOREACH path IN ARRAY ARRAY['/absolute', 'packages/../api', 'packages/./api', 'packages//api', 'packages/api/'] LOOP
    BEGIN
      PERFORM agent_coordination.lease(base || jsonb_build_object('action','claim','package',path));
      RAISE EXCEPTION 'Accepted invalid scope: %', path;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'Accepted invalid%' THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;
ROLLBACK;
