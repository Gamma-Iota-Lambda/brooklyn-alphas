-- GIL Content Calendar: sign-in codes.
-- Replace both phrases, then run this once in the Supabase SQL editor.
--
-- Chapter code: brothers type it the first time they sign in. Share it with the chapter in
-- WhatsApp or at a chapter meeting. At least 6 characters. Case and extra spaces don't matter.
-- Media code: the media team types it once after creating an email login. Keep it to the
-- media team. At least 10 characters.
--
-- Run it again any time to change a code. People who already signed in stay signed in.
-- The media team can also change the chapter code from the page (Manage access).

select cal_private.set_code('chapter', 'REPLACE WITH THE CHAPTER CODE');
select cal_private.set_code('media', 'REPLACE WITH A LONG PHRASE ONLY THE MEDIA TEAM KNOWS');
