-- Merchant logos, so a list of charges reads as a list of places.
--
-- A column of coloured initials is legible but not recognisable — people
-- scan their own statement by logo long before they read a payee string,
-- and "AM" could be Amazon, AMC or a bank. Plaid already returns a logo URL
-- and a website for most merchants; storing them costs two nullable text
-- columns and removes the guessing.
--
-- URLs only. No image is copied anywhere, and a null simply falls back to
-- the coloured initial the app already draws.
alter table transactions add column if not exists logo_url text;
alter table transactions add column if not exists merchant_website text;
