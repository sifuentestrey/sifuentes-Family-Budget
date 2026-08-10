-- Close two real access-control gaps found by the Supabase security advisor
-- after 0003 was applied.
--
-- ---------------------------------------------------------------------------
-- 1. Views were bypassing row level security
-- ---------------------------------------------------------------------------
--
-- A Postgres view executes with the privileges of its OWNER, not the caller.
-- These views are owned by postgres, which bypasses RLS entirely — so any
-- authenticated user could read EVERY household's transactions and bills
-- through them, defeating the policies on the underlying tables. The tables
-- themselves were correctly protected; the views were an unlocked side door.
--
-- security_invoker makes each view evaluate RLS as the querying user, which is
-- what all of them were always intended to do.

alter view spending_transactions set (security_invoker = true);
alter view active_bills set (security_invoker = true);
alter view provider_sync_status set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 2. current_household_ids() was callable by anonymous visitors
-- ---------------------------------------------------------------------------
--
-- Supabase exposes every function in the public schema over REST, and `anon`
-- inherits EXECUTE from PUBLIC — so revoking from `anon` alone accomplishes
-- nothing. The revoke has to happen at the PUBLIC level, with the needed
-- grants added back explicitly.
--
-- `authenticated` MUST retain EXECUTE: RLS policy expressions are evaluated as
-- the querying role, so removing it breaks every policy that calls the helper
-- and the household can read nothing at all. The advisor still warns about that
-- role; the warning is accepted and intentional. The function is SECURITY
-- DEFINER only so it can read household_members without recursively triggering
-- that table's own policy, and it returns nothing but the caller's own
-- household ids — which the caller necessarily already knows.

revoke execute on function current_household_ids() from public;
revoke execute on function current_household_ids() from anon;

grant execute on function current_household_ids() to authenticated;
grant execute on function current_household_ids() to service_role;
