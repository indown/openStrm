export type TreeNode = {
  depth: number;
  key: number;
  name: string;
  parent_key: number;
  children?: TreeNode[];
};

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
