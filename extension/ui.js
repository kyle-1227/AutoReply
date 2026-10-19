export const $ = id => document.getElementById(id);

export function element(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function sendMessage(message) {
  let response;
  try { response = await chrome.runtime.sendMessage(message); }
  catch { throw new Error("插件暂未响应，请在扩展管理页重新加载插件后再试。"); }
  if (!response?.ok) throw new Error(response?.error || "操作未完成，请重试。");
  return response;
}
