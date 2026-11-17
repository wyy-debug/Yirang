import {createInterface} from 'node:readline';
import {hostname,platform,arch} from 'node:os';
const state=()=>({host:hostname(),platform:platform(),arch:arch(),uptimeSeconds:Math.floor(process.uptime()),updatedAt:new Date().toISOString()});
const publish=()=>process.stdout.write(JSON.stringify({event:'state',value:state()})+'\n');
publish();const timer=setInterval(publish,15000);
createInterface({input:process.stdin}).on('line',line=>{try{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,...(message.action==='get_state'?{result:state()}:{error:'未知动作'})})+'\n');}catch(error){process.stderr.write(String(error.message)+'\n');}}).on('close',()=>{clearInterval(timer);process.exit(0);});
