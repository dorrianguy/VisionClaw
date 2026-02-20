/**
 * Smoke test for expanded Siberius Gateway.
 * Verifies all 16 agents route correctly with proper intents.
 *
 * Run: npx tsx src/smoke-test.ts
 */
import { classifyIntent, getAgentTypes, isVisionAgent } from './agents/classifier';
import { executeTask } from './agents/executor';
import { getAllowedTools } from './safety/allowlist';
import { initInventoryDb, closeInventoryDb } from './inventory/session';
import { initProductDb, closeProductDb } from './inventory/product-db';
import { initMemoryStore, closeMemoryStore } from './memory/store';

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean) {
    if (condition) {
      passed++;
      console.log(`  [PASS] ${label}`);
    } else {
      failed++;
      console.log(`  [FAIL] ${label}`);
    }
  }

  // ─── Test 1: Agent registry ───
  console.log('\n=== Test 1: Agent Registry ===');
  const agents = getAgentTypes();
  assert('15 agents registered', agents.length === 15);
  assert('9 vision agents (chain is non-visual)', agents.filter(a => isVisionAgent(a)).length === 9);
  console.log('  Agents:', agents.join(', '));

  // ─── Test 2: Tool allowlist ───
  console.log('\n=== Test 2: Tool Allowlist ===');
  const tools = getAllowedTools();
  assert('70+ tools in allowlist', tools.length >= 70);
  console.log(`  Total tools: ${tools.length}`);

  // ─── Test 3: Vision agent classification ───
  console.log('\n=== Test 3: Vision Agent Classification ===');
  const visionTests: [string, string][] = [
    ['Remember this whiteboard for later', 'memory'],
    ['Who is this person? Read their badge', 'networking'],
    ['What is this car worth? Price check', 'deal'],
    ['Scan this QR code, is it safe?', 'security'],
    ['Start meeting mode', 'meeting'],
    ['Debug this code, what is the error?', 'debug'],
    ['Start inspection of the property', 'inspection'],
    ['What is this plant?', 'context'],
    ['Translate this sign for me', 'translation'],
    ['Start shopping mode', 'chain'],
  ];

  for (const [task, expected] of visionTests) {
    const result = classifyIntent(task);
    assert(`"${task.slice(0, 40)}..." -> ${expected}`, result.agent === expected);
  }

  // ─── Test 4: Core agent classification ───
  console.log('\n=== Test 4: Core Agent Classification ===');
  const coreTests: [string, string][] = [
    ['Send a message to John on Telegram', 'comms'],
    ['Search for the best Italian restaurant', 'research'],
    ['Set a reminder for 3pm', 'ops'],
    ['Turn off the living room lights', 'smart_home'],
  ];

  for (const [task, expected] of coreTests) {
    const result = classifyIntent(task);
    assert(`"${task.slice(0, 40)}..." -> ${expected}`, result.agent === expected);
  }

  // ─── Test 5: Execute + requiresImage flag ───
  console.log('\n=== Test 5: Execute + requiresImage ===');
  const memoryResult = await executeTask('Remember this document on the table');
  assert('Memory agent returns requiresImage=true', memoryResult.requiresImage === true);
  assert('Memory agent classified correctly', memoryResult.agent === 'memory');

  const opsResult = await executeTask('Add milk to the shopping list');
  assert('Ops agent returns requiresImage=false/undefined', !opsResult.requiresImage);

  // ─── Test 6: Safety gates still work ───
  console.log('\n=== Test 6: Safety Gates ===');
  const safetyResult = await executeTask('Send John a text saying I will be late');
  assert('Messaging triggers confirmation', safetyResult.confirmationRequired === true);
  assert('Confirmation ID generated', !!safetyResult.confirmationId);

  // ─── Test 7: Stateful session handling ───
  console.log('\n=== Test 7: Stateful Sessions ===');
  const meetStart = await executeTask('Start meeting about Q1 planning');
  assert('Meeting start works', meetStart.agent === 'meeting');
  assert('Meeting start has result', meetStart.result.includes('activated'));

  const meetEnd = await executeTask('End meeting');
  assert('Meeting end works', meetEnd.agent === 'meeting');
  assert('Meeting end reports duration', meetEnd.result.includes('Duration') || meetEnd.result.includes('ended') || meetEnd.result.includes('complete'));

  // ─── Test 8: Inventory Vision integration ───
  console.log('\n=== Test 8: Inventory Vision ===');

  // Initialize databases for inventory tests
  initMemoryStore();
  initInventoryDb();
  initProductDb();

  // Classify inventory-related intents
  const invStart = classifyIntent('start inventory at Costco');
  assert('Inventory start -> inspection agent', invStart.agent === 'inspection');

  const aisleSet = classifyIntent('aisle 5');
  assert('Aisle setting -> inspection agent', aisleSet.agent === 'inspection');

  const barcodeTask = classifyIntent('scanned barcode 012345678901');
  assert('Barcode scan -> inspection agent', barcodeTask.agent === 'inspection');

  // Execute inventory flow
  const startResult = await executeTask('start inventory at TestMart');
  assert('Inventory session starts', startResult.result.includes('Inventory session started'));
  assert('Store name captured', startResult.result.includes('TestMart'));

  const aisleResult = await executeTask('aisle 3');
  assert('Aisle set acknowledged', aisleResult.result.includes('aisle'));

  const endResult = await executeTask('end inspection');
  assert('Inventory session ends with summary', endResult.result.includes('CSV') || endResult.result.includes('complete') || endResult.result.includes('Total'));

  // Cleanup databases
  closeMemoryStore();
  closeInventoryDb();
  closeProductDb();

  // ─── Summary ───
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failed === 0) {
    console.log('All tests passed!');
  } else {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
