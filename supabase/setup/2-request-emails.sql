-- GIL Content Calendar: request emails to the media team.
-- 1. In Resend (resend.com), verify mail.gil1906.org and create an API key with sending access.
-- 2. Paste the key between the quotes below, then run this once in the Supabase SQL editor.
--
-- Emails come from GIL Content Calendar <calendar@mail.gil1906.org>. To send from another
-- address Resend has verified, add it as a second value, for example:
--   select cal_private.set_email_settings('re_...', 'GIL Media <media@mail.gil1906.org>');
-- Run it again any time to change the key or the sender. supabase/README.md has a test email
-- and how to turn the emails off.

select cal_private.set_email_settings('PASTE THE RESEND API KEY HERE');
