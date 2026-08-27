-- app.internalToken：v1 里 nginx 调 /api/fs/get 用的回环凭据，两者都已移除。
-- 留着的话 GET /api/settings 会一直把它发给浏览器。
DELETE FROM `settings` WHERE `key` = 'app.internalToken';
