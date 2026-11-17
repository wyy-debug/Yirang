const labels=['待命','接收','并行执行','等待确认','暂停','失败','恢复','完成'];
const $=id=>document.getElementById(id);
let current=0,timer,focus='架构图与汇报';
const taskRows=(a,b)=>`<div class="row"><span class="dot running">◌</span><span>架构图 · ${a}</span></div><div class="row"><span class="dot running">◌</span><span>汇报 PPT · ${b}</span></div>`;
const content=[
 '<div class="empty"><h3>一起完成下一件事</h3>选中桌面材料，或直接告诉我想做什么。<br>执行过程和成果会留在这里。</div>',
 '<p class="message">已收到两份材料。我会分别处理架构图和汇报内容，完成后统一汇报。</p><div class="execution"><h4>准备执行 · 2 项工作</h4>'+taskRows('已读取原图','已读取报告')+'</div>',
 '<p class="message">两件事正在同时进行。你可以继续补充要求，也可以交办其他事情。</p><div class="execution"><h4>2 项并行执行</h4>'+taskRows('正在调整节点与连线 · 18 秒','正在整理 5 页汇报 · 12 秒')+'</div><div class="byline">上次进展：刚刚 · 停止一件事不会影响另一件</div>',
 '<p class="message">架构图已完成。PPT 中有一项内容需要你确认，其余工作不受影响。</p><div class="notice"><b>需要确认 · 汇报 PPT</b><p>报告缺少本周数据，是否保留历史数据，并注明日期？</p><div class="actions"><button data-next="6" class="primary">保留并标注日期</button><button data-next="4">稍后处理</button></div></div><div class="file">架构图.svg<small>已生成 · 可以先查看</small></div>',
 '<div class="notice"><b>当前工作已暂停</b><p>进度和已生成文件保留。恢复后继续处理剩余内容。</p><button data-next="6">继续工作</button></div>',
 '<p class="message">架构图已完成，但 PPT 导出失败。没有把失败当作完成。</p><div class="notice"><b>PPT 导出失败</b><p>模拟原因：写入目标文件时被占用。已保留草稿与执行记录。</p><button data-next="6">重试 PPT 导出</button></div><div class="file">架构图.svg<small>已保存到桌面 · 不需要重新生成</small></div>',
 '<p class="message">继续处理 PPT，沿用已保存的架构图和草稿。</p><div class="execution"><h4>已恢复</h4>'+taskRows('已完成 ✓','正在导出 · 3 秒')+'</div>',
 '<p class="message">两件事都已完成：架构图可编辑，汇报共 5 页。历史数据已注明日期。</p><div class="result"><h4>交付成果 · 2 个文件</h4><div class="file">架构图.svg<small>已保存到桌面 · 原对象已更新</small></div><div class="file">Crash 汇报.pptx<small>已保存到桌面 · 5 页</small></div><div class="actions"><button id="locate">定位桌面</button><button data-next="2">继续修改</button></div></div>'
];
function render(index){current=index;document.querySelectorAll('#steps button').forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));});$('summary').textContent=index===0?'工作 · 暂无进行中的事情':index===7?'工作 · 2 项已完成':index===3?'工作 · 1 项需要你 · 1 项已完成':index===5?'工作 · 1 项失败 · 1 项已完成':`工作 · ${labels[index]}`;
 $('jobs').innerHTML=index===0?'':`<button data-job="架构图">可编辑架构图 <em>${index>=3?'已完成':'执行中'}</em></button><button data-job="汇报 PPT">汇报 PPT <em>${labels[index]}</em></button>`;
 $('feed').innerHTML=(index?'<div class="message user">根据原图做一个可编辑版本，同时整理一份汇报 PPT。</div><div class="byline">Codex</div>':'')+content[index];$('pause').hidden=[0,4,7].includes(index);$('target').textContent=index===0?'新事情':`当前：${focus}`;
}
labels.forEach((name,i)=>{const b=document.createElement('button');b.textContent=name;b.onclick=()=>{stop();render(i)};$('steps').append(b)});
function stop(){clearInterval(timer);timer=null;$('play').textContent='自动播放'}
$('play').onclick=()=>{if(timer)return stop();render(1);$('play').textContent='停止播放';timer=setInterval(()=>{if(current===7)return stop();render(current+1)},3500)};
document.body.addEventListener('click',e=>{const b=e.target.closest('button');if(b?.dataset.next){stop();render(Number(b.dataset.next))}if(b?.dataset.job){focus=b.dataset.job;$('target').textContent=`当前：${focus}`;$('worklist').open=false}if(b?.id==='locate'){document.querySelector('.diagram').style.outline='2px solid var(--accent)';b.textContent='已定位（模拟）'}});
$('pause').onclick=()=>{stop();render(4)};$('new').onclick=()=>{stop();focus='新事情';render(0);document.querySelector('textarea').focus()};
$('composer').onsubmit=e=>{e.preventDefault();const input=document.querySelector('textarea');if(!input.value.trim())return;stop();render(1);$('feed').querySelector('.user').textContent=input.value;input.value=''};render(0);
