-- Household self-service bootstrap.
--
-- RLS on households/household_members requires already being a member to
-- write to either table (current_household_ids() is derived from
-- household_members). That is correct for every case except the very first
-- one: a brand-new user has no membership row yet, so a client-side INSERT
-- can never pass its own `with check`. This function runs as its caller only
-- — no household_id or target user is accepted as input — so it can safely
-- bypass RLS to perform that one bootstrap step without becoming a way to
-- join or create households on someone else's behalf.

create or replace function bootstrap_household(display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  new_id uuid;
begin
  select household_id into existing_id
  from household_members
  where user_id = auth.uid()
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  insert into households (name) values ('Our Household') returning id into new_id;

  insert into household_members (household_id, user_id, display_name)
  values (new_id, auth.uid(), coalesce(display_name, split_part(auth.email(), '@', 1)));

  return new_id;
end;
$$;

revoke all on function bootstrap_household(text) from public;
revoke all on function bootstrap_household(text) from anon;
grant execute on function bootstrap_household(text) to authenticated;
