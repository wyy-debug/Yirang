export const widgetContract = {
  sizes: {
    1: {
      columns: 1,
      rows: 1,
      width: 220,
      height: 220,
    },
    2: {
      columns: 2,
      rows: 1,
      width: 456,
      height: 220,
    },
    4: {
      columns: 2,
      rows: 2,
      width: 456,
      height: 456,
    },
    8: {
      columns: 4,
      rows: 2,
      width: 928,
      height: 456,
    },
  },
  surfaces: {
    canvas: '自由画布，支持固定到顶部',
    dashboard: '组件看板，独立于画布；widget_save surface=dashboard, order=排序数值',
  },
  remote:
    '远程服务使用同样的 widgets 声明。后端持续发布 {event:state,value:{...}}；组件用 yirang.widget.watchState((state,connection)=>{})，connection.online=false 时显示离线状态与最近数据。不得由每个组件自行轮询远端或启动监控；连接由宿主管理。远程源码在服务主机维护，不能对远程实例调用本机 draft_write。',
  gap: 16,
  headerHeight: 34,
  manifestExample: {
    widgets: [
      {
        id: 'status',
        name: '运行状态',
        sizes: [1, 2, 4, 8],
        entry: 'ui/widgets/status.html',
      },
    ],
  },
  rules:
    '这是供一壤内置 Codex 使用的开发规范。小组件最多 8 格，只支持 1/2/4/8。使用独立响应式 HTML，不把完整应用缩小；入口位于 ui.entry 同目录或其子目录。共享应用后端、配置与 yirang.state，不启动额外服务。URL 参数 widget、size 指定当前规格；SDK yirang.widget.watchState 读取应用共享状态，返回取消函数，离屏时宿主卸载组件，重新可见时读取最新状态。使用 yirang.state.set 发布状态；后端也可输出 JSON 行 {event:"state",value:{...}} 发布最多 64 KiB 的公开状态（不含密钥）；后台可靠监控使用宿主 schedules，禁止依赖小组件计时器执行通知等副作用。源码通过 draft_create/read/write/changes/preview 和用户发布确认更新；widgets_list 查询声明与位置，widget_save 更新原 id 保持位置，可用 width(220–1920)、height(160–1200) 设置显示尺寸，pinned=true 固定到顶部栏（不随画布缩放平移），false 回到画布；格数 size 仍限制为 1/2/4/8。页面需响应 iframe 实际尺寸变化，不依赖固定像素画布。widget_save 更新原 id 保持位置，widget_remove 只移除组件。用户摆放使用应用中的添加小组件入口。',
};
