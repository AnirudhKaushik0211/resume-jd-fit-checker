'use strict';

// Preloaded (node --require) into every test process of a profile suite run by scripts\test-profile.cjs when
// JDFC_PASSWORD is set: unlocks the protected JDFC_PROFILE so suite files that call loadConfig() directly can read it.
// A wrong password fails the process with a clear WRONG_PASSWORD error.

require('../lib/profiles.cjs').unlockFromEnv(process.env.JDFC_PROFILE);
