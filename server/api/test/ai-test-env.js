'use strict';
// Never inherit a production quota URL or signing secret into mocked route tests.
process.env.NODE_ENV = 'test';
process.env.AI_REDIS_URL = '';
process.env.AI_SESSION_SECRET = 'local-test-only-session-secret-32-characters';
process.env.AI_GLOBAL_DAY_MAX = '1000';
process.env.AI_GLOBAL_CONCURRENT_MAX = '5';
process.env.AI_SESSION_DAY_MAX = '20';
