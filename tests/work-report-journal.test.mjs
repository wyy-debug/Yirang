import test from 'node:test';
import assert from 'node:assert/strict';
import {projectWorkReport, projectWorkReports} from '../apps/electron/work/work-report-journal.mjs';
import {workStatus} from '../apps/electron/work/work-state-labels.js';
test('partial delivery retains files, failed children and current generation without claiming completion', () => {
  const task = {id:'parent',revision:8,management:{state:'review',generation:2,currentRequirementsRevision:3,
    runs:[{id:'old',generation:1,requirementsRevision:3,state:'succeeded',resultText:'old'},
      {id:'new',generation:2,requirementsRevision:3,state:'failed',resultText:'SVG only',reason:'PPT failed'}],
    artifacts:[{objectId:'svg',revision:2,validity:'current'},{objectId:'old',validity:'stale'}]}};
  const snapshot={workspaceId:'desk',tasks:[task,
    {id:'child',title:'PPT',management:{parentTaskId:'parent',parentRequirementsRevision:3,state:'attention',reason:'conversion failed'}},
    {id:'obsolete',management:{parentTaskId:'parent',parentRequirementsRevision:2,state:'attention'}}]};
  const report=projectWorkReport(task,snapshot);
  assert.equal(report.state,'attention'); assert.equal(report.resultText,'SVG only');
  assert.deepEqual(report.artifacts.map(f=>f.objectId),['svg']);
  assert.equal(report.children.length,1); assert.match(report.reason,/PPT failed/);
  assert.match(report.reason,/conversion failed/); assert.equal(workStatus(task).tone,'blocked');
  assert.equal(projectWorkReports(snapshot).length,1);
  assert.deepEqual(projectWorkReport(task,snapshot), report);
});
test('empty completed execution is not invented into a textual result', () => {
  const report=projectWorkReport({id:'t',management:{state:'review',currentRequirementsRevision:1,runs:[]}});
  assert.equal(report.resultText,''); assert.match(report.reason,/尚无/);
});

test('pending approval is a user decision, not a failed work to restart', () => {
  const status=workStatus({management:{state:'attention',generation:1,currentRequirementsRevision:1,
    runs:[{id:'r',generation:1,requirementsRevision:1,state:'waiting'}]}});
  assert.equal(status.tone,'ask');
  assert.equal(status.action,undefined);
  assert.match(status.line,/授权/);
});
