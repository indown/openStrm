/**
 *   pnpm test:file src/services/cloud-115/share.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cloud115ApiError, ShareBusyError } from "./client.js";
import { ShareApiError, checkShareResponse, shareExtractPayload, uniqueFileIds } from "./share.js";

test("同一个 id 只留一次、顺序不变、空的丢掉：弹框重复勾选或 API 重复传 id 都不该让 115 复制两份", () => {
  assert.deepEqual(uniqueFileIds(["3", 3, "1", "", " 3 ", "2", "1"]), ["3", "1", "2"]);
  assert.deepEqual(uniqueFileIds(42), [42]);
  assert.deepEqual(uniqueFileIds([]), []);
});

test("分享接口回了不行：分享没了、提取码不对是 ShareApiError；太频繁、繁忙、一句话都没说的是 ShareBusyError（不算分享没了）", () => {
  const thrown = (resp: { state?: boolean; errno?: number; error?: string }) => {
    try {
      checkShareResponse(resp);
    } catch (err) {
      return err;
    }
    return null;
  };
  for (const error of ["分享已取消", "链接已过期", "访问码错误", "请输入访问码", "分享者用户封禁链接查看受限", "登录超时，请重新登录"]) {
    const err = thrown({ state: false, errno: 4100010, error });
    assert.ok(err instanceof ShareApiError, error);
    assert.equal((err as ShareApiError).message, error);
  }
  for (const error of ["操作过于频繁，请稍后再试", "请求过于频繁", "系统繁忙，请稍后再试", "服务器开小差了", "Too many requests"]) {
    const err = thrown({ state: false, errno: 911, error });
    assert.ok(err instanceof ShareBusyError, error);
    assert.ok(err instanceof Cloud115ApiError, "照样是 115 的业务错误：登录失效、风控还能按文案认");
    assert.ok(!(err instanceof ShareApiError));
  }
  const silent = thrown({ state: false, errno: 4100001 });
  assert.ok(silent instanceof ShareBusyError);
  assert.match((silent as Error).message, /没说原因（errno 4100001）/);
  assert.ok(thrown({ state: false, error: "  " }) instanceof ShareBusyError);
  assert.equal(thrown({ state: true, errno: 0 }), null);
});

test("解析分享码：裸码、码-提取码、码?password=提取码（不分大小写）；链接里的提取码到片段、标点为止", () => {
  assert.deepEqual(shareExtractPayload("swzjt593ztd?password=v421"), { share_code: "swzjt593ztd", receive_code: "v421" });
  assert.deepEqual(shareExtractPayload("SWZJT593ZTD?Password=V421"), { share_code: "SWZJT593ZTD", receive_code: "V421" });
  assert.deepEqual(shareExtractPayload("swzjt593ztd-v421"), { share_code: "swzjt593ztd", receive_code: "v421" });
  assert.deepEqual(shareExtractPayload("swzjt593ztd"), { share_code: "swzjt593ztd", receive_code: "" });
  assert.deepEqual(shareExtractPayload("/s/swzjt593ztd?password=v421"), { share_code: "swzjt593ztd", receive_code: "v421" });
  assert.deepEqual(shareExtractPayload("/s/swzjt593ztd-v421"), { share_code: "swzjt593ztd", receive_code: "v421" });
  assert.deepEqual(shareExtractPayload("https://115.com/s/swzjt593ztd-v421"), { share_code: "swzjt593ztd", receive_code: "v421" });
  assert.deepEqual(shareExtractPayload("https://115.com/s/swzjt593ztd-v421?password=zz11"), { share_code: "swzjt593ztd", receive_code: "zz11" });
  assert.deepEqual(shareExtractPayload("https://115cdn.com/s/swhk9bx3wwq?password=sff1#"), { share_code: "swhk9bx3wwq", receive_code: "sff1" });
  assert.deepEqual(shareExtractPayload("https://115.com/s/swhk9bx3wwq?password=sff1）"), { share_code: "swhk9bx3wwq", receive_code: "sff1" });
  assert.throws(() => shareExtractPayload("沙丘2"));
});
