-- Studio branding for the iOS app (avatar, hero image, website/Instagram
-- pills). All nullable: there is no write API yet (values are set via SQL),
-- and the app hides the corresponding UI when a field is null.
alter table public.studios
  add column image_url            text,
  add column background_image_url text,
  add column website              text,
  add column instagram_url        text;
