import { useRef, useState } from "react";
import { toast } from "sonner";
import { api, type ShareEntry, type ShareInfo } from "@/lib/api";
import { apiErrorMessage } from "@/lib/axios";

/** 分享详情弹框一页多少条；115 按这个给，夸克固定 50 一页 */
export const SHARE_PAGE_SIZE = 50;

export interface ShareCrumb {
  id: string;
  name: string;
}

interface LoadOptions {
  /** 先把弹框打开再加载（影库卡片点开时用），默认加载成功后才打开 */
  openImmediately?: boolean;
  startCid?: string | number;
  startCrumbs?: ShareCrumb[];
  /** 失败时的兜底文案 */
  failMessage?: string;
}

/**
 * 分享详情弹框的状态与加载。顶部搜索栏和影库页各有一个入口，逻辑完全相同：
 * 并行取分享信息和根目录列表，成功则交给 ShareDetailDialog 展示。
 */
export function useShareDetail() {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [list, setList] = useState<ShareEntry[]>([]);
  const [count, setCount] = useState(0);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [startCid, setStartCid] = useState<string | number | undefined>(undefined);
  const [startCrumbs, setStartCrumbs] = useState<ShareCrumb[] | undefined>(undefined);
  // 连续点开两个分享时只认最后一次，慢的旧响应不能把新分享盖掉
  const seqRef = useRef(0);

  const load = async (url: string, opts: LoadOptions = {}) => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("请输入分享链接（115 或夸克）");
      return;
    }
    const seq = ++seqRef.current;
    setLink(trimmed);
    setStartCid(opts.startCid);
    setStartCrumbs(opts.startCrumbs);
    setLoading(true);
    if (opts.openImmediately) {
      setInfo(null);
      setList([]);
      setCount(0);
      setNext(undefined);
      setOpen(true);
    }
    // 直接定位到子目录时根目录列表用不上（弹框自己拉 startCid 那一层），不拉它：
    // 否则列表到达后会再触发一次弹框的初始化效果，把子目录多拉一遍
    const startCidStr = opts.startCid != null ? String(opts.startCid) : "";
    const needRootList = !startCidStr || startCidStr === "0";
    try {
      const [shareInfo, page] = await Promise.all([
        api.share.info(trimmed),
        needRootList ? api.share.list(trimmed, "0", undefined, SHARE_PAGE_SIZE) : Promise.resolve(null),
      ]);
      if (seq !== seqRef.current) return;
      setInfo(shareInfo ?? null);
      if (page) {
        setList(page.entries ?? []);
        setCount(page.total ?? page.entries?.length ?? 0);
        setNext(page.next);
      }
      setOpen(true);
    } catch (err) {
      if (seq !== seqRef.current) return;
      toast.error(apiErrorMessage(err, opts.failMessage ?? "获取分享详情失败"));
      if (opts.openImmediately) setOpen(false);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };

  /** 直接铺给 <ShareDetailDialog> 的 props */
  const dialogProps = {
    open,
    onOpenChange: setOpen,
    shareInfo: info,
    fileList: list,
    fileCount: count,
    nextCursor: next,
    shareLink: link,
    loading,
    startCid,
    startCrumbs,
  };

  return { open, setOpen, link, setLink, loading, load, dialogProps };
}
