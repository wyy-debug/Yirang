import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
const { version } = JSON.parse(await readFile('package.json', 'utf8')),
  zip = new JSZip();
zip.file('yirang-service.mjs', await readFile('dist/yirang-service.mjs'));
zip.file(
  'README.md',
  [
    '# 一壤远程服务',
    '',
    '安装 Node.js 24.12.x 后，执行 `node yirang-service.mjs --init ./service` 初始化配置。',
    '在 `service/service.json` 中指定要托管的应用。应用路径相对于配置文件。',
    '包内 `example-app` 是可选的主机状态示例。',
    '',
    '审阅应用源码后，首次使用 `node yirang-service.mjs --config ./service/service.json --approve-code` 启动。',
    '后续启动可省略 `--approve-code`。',
    '在一壤的远程服务设置中填写服务地址和配置生成的连接令牌。',
    '',
    'macOS 可按需填写 `com.yirang.service.plist.example` 中的绝对路径并交给 launchd。',
    '',
  ].join('\n'),
);
zip.file(
  'com.yirang.service.plist.example',
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.yirang.service</string>
<key>ProgramArguments</key><array><string>/ABSOLUTE/PATH/TO/node</string><string>/ABSOLUTE/PATH/TO/yirang-service.mjs</string><string>--config</string><string>/ABSOLUTE/PATH/TO/service/service.json</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>/ABSOLUTE/PATH/TO/service/stdout.log</string>
<key>StandardErrorPath</key><string>/ABSOLUTE/PATH/TO/service/stderr.log</string>
</dict></plist>`,
);
for (const name of ['yirang.app.json', 'server.mjs', 'ui/index.html', 'ui/yirang.js'])
  zip.file('example-app/' + name, await readFile('examples/remote-status/' + name));
await mkdir('release/installers', { recursive: true });
const target = resolve(`release/installers/Yirang-Service-${version}.zip`);
await writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(target);
