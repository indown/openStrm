-- 限流设置跟着语义改名：整组 app.download → app.throttle，三个字段换名，值不动。
-- linkMaxPerSecond / linkMaxConcurrent 管的其实是这个账号的全部接口请求，不只是取直链；整组也不只管下载。
-- json_patch 把没填过的字段去掉（json_extract 取不到是 NULL）；已经有 app.throttle 的不覆盖。
INSERT INTO `settings` (`key`, `value`)
SELECT 'app.throttle', json_patch('{}', json_object(
  'requestsPerSecond', json_extract(`value`, '$.linkMaxPerSecond'),
  'requestConcurrency', json_extract(`value`, '$.linkMaxConcurrent'),
  'downloadConcurrency', json_extract(`value`, '$.downloadMaxConcurrent')
))
FROM `settings`
WHERE `key` = 'app.download' AND json_valid(`value`)
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'app.download';
