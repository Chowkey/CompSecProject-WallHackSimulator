/*
 * kernel.js - Simulated process memory, the module table, and the scoring oracle.
 *
 * EDUCATIONAL SIMULATION - part of the Client Integrity Sandbox.
 *
 * This is the loader's core state, split out from main.js so that it can be
 * loaded without a DOM - which is what lets tools/selftest.mjs exercise all
 * twenty-five defense/bypass combinations in Node, against the same code the
 * page runs rather than against a reimplementation of it.
 *
 * Like hash.js and main.js this file is unsigned, because it is part of the
 * verifier. A verifier cannot verify itself; something at the bottom of the
 * stack is always trusted by assumption. Naming that is more honest than
 * hiding it, and it is the same gap Defense 4 loses to.
 */
(function (global) {
  'use strict';

  var Sandbox = global.Sandbox = global.Sandbox || {};

  /**
   * modules  - loaded images, keyed by id. The loader owns this list, and it is
   *            the only list any module enumeration can consult. It stands in
   *            for the PEB module list.
   * private  - stands in for executable pages backed by no image. Injected code
   *            has to live somewhere; when it lives here, a scan can find it.
   */
  Sandbox.processMemory = {
    modules: Object.create(null),
    private: Object.create(null)
  };

  var nextBase = 0x400000;

  Sandbox.signing = {
    available: false,
    manifest: { key: '', modules: {} },
    results: {},
    allValid: false,
    verifiedAt: 0
  };

  /**
   * Create the region for a module the loader is about to execute. Called by
   * the loader before the module's code runs, so that a region exists even for
   * a module that never registers exports.
   */
  Sandbox.mapModule = function (id, fileSource, signed) {
    var region = Sandbox.processMemory.modules[id] ||
      (Sandbox.processMemory.modules[id] = { id: id, base: nextBase += 0x10000 });
    region.id = id;
    region.fileSource = fileSource;
    region.signed = !!signed;
    if (!region.exports) {
      region.exports = null;
      region.exportOrder = [];
    }
    return region;
  };

  /**
   * Called by a module once it has finished defining itself. This attaches the
   * exports table that everything else - the render loop, the defenses, the
   * attacker - dispatches through. Dispatching through a table rather than
   * through captured references is what makes hooking expressible at all.
   */
  Sandbox.registerModule = function (id, exports, extra) {
    var region = Sandbox.processMemory.modules[id] ||
      (Sandbox.processMemory.modules[id] = { id: id, base: nextBase += 0x10000 });
    region.id = id;
    region.exports = exports;
    region.exportOrder = Object.keys(exports);
    if (extra) {
      Object.keys(extra).forEach(function (k) { region[k] = extra[k]; });
    }
    return region;
  };

  /**
   * Ground truth about what the attacker actually did.
   *
   * This exists so the results matrix can tell a real detection from a lucky
   * alarm. NO DEFENSE READS IT. A client-side check that could consult ground
   * truth would not be a client-side check - it would be the server, and the
   * entire question the project asks would be begged.
   */
  Sandbox.truthOracle = {
    attackerLevel: 0,
    facts: {
      functionsHooked: false,
      privateRegionAllocated: false,
      globalArtifact: false,
      pipelineInjected: false,
      filesModified: false
    },

    shouldDetect: function (defenseId) {
      var f = this.facts;
      switch (defenseId) {
        case 'checksum':
        case 'hooks':
          return f.functionsHooked;
        case 'modules':
          return f.privateRegionAllocated || f.globalArtifact || f.pipelineInjected;
        case 'signing':
          // The honest question is "is this client compromised", and signing is
          // scored against that. It answers a narrower one - "was the file
          // altered" - which is exactly why it misses everything that patches
          // memory instead of disk.
          return f.filesModified || f.functionsHooked || f.pipelineInjected;
        case 'challenge':
          return f.functionsHooked || f.pipelineInjected;
        default:
          return false;
      }
    },

    isCompromised: function () {
      var f = this.facts;
      return f.functionsHooked || f.pipelineInjected ||
             f.privateRegionAllocated || f.globalArtifact || f.filesModified;
    },

    reset: function () {
      this.attackerLevel = 0;
      Object.keys(this.facts).forEach(function (k) { this.facts[k] = false; }, this);
    }
  };
})(typeof self !== 'undefined' ? self : this);
