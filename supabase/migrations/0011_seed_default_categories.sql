-- Every household's categories table has been empty since the app existed.
--
-- categorizeBatch (src/engine/categorize.js, shared into every sync function)
-- matches a payee to a category NAME via keyword/PFC rules, then the caller
-- looks up that name in the household's own `categories` table to get the
-- id transactions.category_id actually needs. bootstrap_household never
-- inserted the default taxonomy (SEED_CATEGORIES, src/engine/seed-rules.js)
-- into that table for any household, so the lookup has always silently
-- returned null — every transaction, for every household, forever. This
-- surfaced today only because it's the first time sync-transactions has
-- ever successfully written real Plaid data (see the sibling migration
-- fixing that insert bug): 61 of 479 transactions matched a keyword rule by
-- name, 0 got a category_id.

create or replace function seed_default_categories(target_household_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into categories (household_id, name, category_group, kind, sort_order)
  values
    (target_household_id, 'Rent/Mortgage', 'Housing', 'fixed', 1),
    (target_household_id, 'Utilities', 'Housing', 'fixed', 2),
    (target_household_id, 'Internet/Phone', 'Housing', 'fixed', 3),
    (target_household_id, 'Home Maintenance', 'Housing', 'sinking', 4),
    (target_household_id, 'Groceries', 'Food', 'variable', 5),
    (target_household_id, 'Dining Out', 'Food', 'variable', 6),
    (target_household_id, 'Coffee', 'Food', 'variable', 7),
    (target_household_id, 'Gas', 'Transport', 'variable', 8),
    (target_household_id, 'Car Payment', 'Transport', 'fixed', 9),
    (target_household_id, 'Car Insurance', 'Transport', 'fixed', 10),
    (target_household_id, 'Car Maintenance', 'Transport', 'sinking', 11),
    (target_household_id, 'Registration/Fees', 'Transport', 'sinking', 12),
    (target_household_id, 'Parking/Transit', 'Transport', 'variable', 13),
    (target_household_id, 'Medical', 'Health', 'variable', 14),
    (target_household_id, 'Pharmacy', 'Health', 'variable', 15),
    (target_household_id, 'Health Insurance', 'Health', 'fixed', 16),
    (target_household_id, 'Fitness', 'Health', 'fixed', 17),
    (target_household_id, 'Childcare', 'Family', 'fixed', 18),
    (target_household_id, 'Kids Supplies', 'Family', 'variable', 19),
    (target_household_id, 'Pets', 'Family', 'variable', 20),
    (target_household_id, 'Shopping', 'Personal', 'variable', 21),
    (target_household_id, 'Clothing', 'Personal', 'variable', 22),
    (target_household_id, 'Personal Care', 'Personal', 'variable', 23),
    (target_household_id, 'Gifts', 'Personal', 'sinking', 24),
    (target_household_id, 'Subscriptions', 'Lifestyle', 'fixed', 25),
    (target_household_id, 'Entertainment', 'Lifestyle', 'variable', 26),
    (target_household_id, 'Travel', 'Lifestyle', 'sinking', 27),
    (target_household_id, 'Hobbies', 'Lifestyle', 'variable', 28),
    (target_household_id, 'Insurance', 'Financial', 'fixed', 29),
    (target_household_id, 'Taxes', 'Financial', 'sinking', 30),
    (target_household_id, 'Fees/Interest', 'Financial', 'variable', 31),
    (target_household_id, 'Savings', 'Financial', 'fixed', 32),
    (target_household_id, 'Paycheck', 'Income', 'income', 33),
    (target_household_id, 'Other Income', 'Income', 'income', 34),
    (target_household_id, 'Transfer', 'Transfer', 'transfer', 35),
    (target_household_id, 'Uncategorized', 'Other', 'variable', 36)
  on conflict (household_id, name) do nothing;
$$;

revoke all on function seed_default_categories(uuid) from public, anon, authenticated;
grant execute on function seed_default_categories(uuid) to service_role;

-- Backfill every household that exists today and has none — this is what
-- actually fixes the current household's 479 uncategorized transactions.
do $$
declare
  h record;
begin
  for h in
    select households.id
    from households
    left join categories on categories.household_id = households.id
    group by households.id
    having count(categories.id) = 0
  loop
    perform seed_default_categories(h.id);
  end loop;
end $$;

-- New households from here on get seeded at creation, not left for the next
-- sync to silently fail on.
create or replace function bootstrap_household(display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id       uuid;
  invite_id         uuid;
  invited_household uuid;
  new_id            uuid;
begin
  select household_id into existing_id
  from household_members
  where user_id = auth.uid()
  limit 1;

  if existing_id is not null then
    return existing_id;
  end if;

  select id, household_id into invite_id, invited_household
  from household_invites
  where lower(email) = lower(auth.email())
    and accepted_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if invited_household is not null then
    insert into household_members (household_id, user_id, display_name)
    values (invited_household, auth.uid(),
            coalesce(display_name, split_part(auth.email(), '@', 1)))
    on conflict (household_id, user_id) do nothing;

    update household_invites
    set accepted_at = now(),
        accepted_by = auth.uid()
    where id = invite_id;

    return invited_household;
  end if;

  insert into households (name) values ('Our Household') returning id into new_id;

  insert into household_members (household_id, user_id, display_name)
  values (new_id, auth.uid(), coalesce(display_name, split_part(auth.email(), '@', 1)));

  perform seed_default_categories(new_id);

  return new_id;
end;
$$;

revoke all on function bootstrap_household(text) from public;
revoke all on function bootstrap_household(text) from anon;
grant execute on function bootstrap_household(text) to authenticated;
