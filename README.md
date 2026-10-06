# 视觉回归基线审批与差异定位平台

基于 Vue 3 的本地可运行前端工程，用于管理截图回归运行、差异定位、忽略规则和基线审批。数据由 Axios 模拟适配器提供，并持久化到浏览器 `localStorage`。

## 技术栈

- Vue 3 + TypeScript + Vite
- Arco Design Vue
- Pinia
- Vue Router
- TanStack Query for Vue
- Axios

## 启动

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18471`。

## 构建

```bash
npm run build
npm run preview
```

## 工作区

- 运行概览：发布阻断项、差异趋势和最近运行
- 回归运行：按项目、页面、设备、主题、构建和状态筛选，合并重复运行
- 差异定位：基线/当前图并排、区域缩放、严重级筛选、区域忽略和审批
- 审批队列：批量合并、风险排序和审批入口
- 历史基线：版本、批准人、原因、关联运行和启用状态
- 忽略规则：动态区域选择器、作用范围、最大色差和启用控制
- 结果导出：导出包含运行、差异和审批证据的 CSV

浏览器首次打开时会自动写入示例数据。审批或规则调整会写入 `visual-regression-platform-v1` 对应的本地存储键。
