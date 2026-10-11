/**
 * 浏览器存储的安全封装 —— hub 1.4.1 「第三方主题请适配」里点名的头号问题：
 * 浏览器**禁用站点数据**（隐私模式 / 站点设置里关掉存储）时，连 `localStorage` 的
 * **读取**都会抛 `SecurityError`；裸调用只要落在 `useState` 初始化器或某个副作用里，
 * 首次渲染就整棵树炸掉、页面一片空白（官方两个主题在 1.4.1 随附版里修的就是这个）。
 *
 * 口径：读不到就当「没存过」，写不进就当「这次会话内有效」——存储被禁时页面照常渲染、
 * 开关照常能用，只是刷新后记不住。真正的业务数据（offlineCache）另有自己的包装，
 * 这里只服务访客偏好这类小键值。
 */

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 记不住就记不住，界面照常
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

export function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 忽略
  }
}
