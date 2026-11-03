// Public category metadata. Reply instructions remain in the native component.
export const CATEGORY_RULES_VERSION = 1;
export const CATEGORY_SOURCE_NAMES = Object.freeze({ product: "商品指定", shop: "店铺唯一类目", base: "基础规则兜底" });
export const CATEGORIES = Object.freeze([
  ["fashion", "服饰鞋包与配饰"], ["beauty", "美妆个护"], ["food", "食品饮料"],
  ["wellness", "营养与健康用品"], ["home", "家居家纺与收纳"], ["kitchen", "厨具餐具与清洁用品"],
  ["electronics", "数码家电与照明"], ["baby", "母婴用品"], ["toys_office", "玩具文具与办公"],
  ["sports", "运动户外"], ["pets", "宠物用品"], ["automotive", "汽摩配件"],
  ["tools_garden", "五金工具与园艺"], ["books_music", "图书文娱与乐器"], ["other", "其他商品"],
].map(([id, name]) => Object.freeze({ id, name })));
const names = new Map(CATEGORIES.map(item => [item.id, item.name]));
const invalid = () => Object.assign(new Error("商品类目无法识别，请刷新资料并确认插件与本机组件均已更新。"), { status: 400, code: "INPUT_INVALID" });

export function categoryId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!names.has(value)) throw invalid();
  return value;
}

export function categoryIds(values = []) {
  if (!Array.isArray(values) || values.length > CATEGORIES.length || values.some(value => !categoryId(value))) throw invalid();
  return CATEGORIES.filter(item => values.includes(item.id)).map(item => item.id);
}

export const categoryName = id => id ? names.get(id) || "未识别类目" : "全品类基础规则";

// Product intent, including explicit "other", takes precedence over shop defaults.
export function resolveCategory(product, selected = []) {
  const id = categoryId(product?.categoryId), shop = categoryIds(selected);
  if (id) return { id, source: "product" };
  return shop.length === 1 ? { id: shop[0], source: "shop" } : { id: null, source: "base" };
}
