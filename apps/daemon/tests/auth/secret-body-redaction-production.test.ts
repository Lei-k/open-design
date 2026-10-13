// S58 repair 1: secret-bearing endpoints never echo request bodies (NODE_ENV=production).
import { secretBodyRedactionSuite } from './secret-body-redaction-suite.js';

secretBodyRedactionSuite('production');
