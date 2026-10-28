/**
 * BDD Hooks — setup and teardown for Cucumber scenarios
 */

const { Before, After, BeforeAll, AfterAll } = require('@cucumber/cucumber');
const KurrentWorld = require('./world');

// Shared world instance
let world;

BeforeAll(function () {
  console.log('\n🧪 Kurrent BDD Test Suite Starting\n');
  console.log(`   Spec version: ${require('../../bdd-version.json').version}`);
  console.log(`   Date: ${new Date().toISOString()}\n`);
});

Before(function () {
  // Fresh world for each scenario
  world = new KurrentWorld();
  this.world = world;
});

After(function (scenario) {
  // Log failures for debugging
  if (scenario.result.status === 'FAILED') {
    console.log(`\n  ❌ FAILED: ${scenario.pickle.name}`);
    if (this.world.errors.length > 0) {
      console.log(`     Errors: ${JSON.stringify(this.world.errors)}`);
    }
  }

  // Reset state
  if (this.world) {
    this.world.reset();
  }
});

AfterAll(function () {
  console.log('\n🧪 Kurrent BDD Test Suite Complete\n');
});

module.exports = { getWorld: () => world };
