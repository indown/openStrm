export type TreeNode = {
  depth: number;
  key: number;
  name: string;
  parent_key: number;
  children?: TreeNode[];
};

/**
 * 把一条条路径合并成扁平节点表（根节点 key 0、名字为空），交给 buildTree 组装。
 *
 * 同一父节点下同名的段只建一次，用 `${parentKey}\0${name}` 做索引。
 * 以前 115 导出那边是每个段在整张表里 find 一遍：10 万条路径、平均三层，
 * 就是上百亿次比较，全量同步时 API 进程要卡几分钟。
 *
 * 调用方自己切段：115 的导出行末可能带换行要 trim，openlist 的名字则原样保留。
 */
export class TreeBuilder {
  readonly nodes: TreeNode[] = [{ depth: 0, key: 0, name: "", parent_key: 0 }];
  private readonly index = new Map<string, number>();
  private counter = 1;

  /** @param segments 一条路径的各段，不含空段 */
  add(segments: string[]): void {
    let parentKey = 0;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      const indexKey = `${parentKey}\0${name}`;
      let key = this.index.get(indexKey);
      if (key === undefined) {
        key = this.counter++;
        this.nodes.push({ depth: i + 1, key, name, parent_key: parentKey });
        this.index.set(indexKey, key);
      }
      parentKey = key;
    }
  }
}

export function buildTree(list: TreeNode[]): TreeNode[] {
  const map = new Map<number, TreeNode>();
  const roots: TreeNode[] = [];
  list.forEach((n) => map.set(n.key, { ...n, children: [] }));
  list.forEach((n) => {
    if (n.parent_key === 0) roots.push(map.get(n.key)!);
    else map.get(n.parent_key)?.children!.push(map.get(n.key)!);
  });
  return roots;
}

export function collectFilesAndTopEmptyDirs(nodes: TreeNode[], parentPath = ""): string[] {
  const result: string[] = [];
  function dfs(nodeList: TreeNode[], basePath: string): boolean {
    let hasFile = false;
    for (const node of nodeList) {
      const cur = basePath ? `${basePath}/${node.name}` : node.name;
      if ((!node.children || node.children.length === 0) && /\.[a-z0-9]+$/i.test(node.name)) {
        result.push(cur);
        hasFile = true;
      } else if (node.children && node.children.length > 0) {
        if (dfs(node.children, cur)) hasFile = true;
      }
    }
    if (!hasFile && basePath) {
      result.push(basePath);
      return true;
    }
    return hasFile;
  }
  dfs(nodes, parentPath);
  return result;
}
