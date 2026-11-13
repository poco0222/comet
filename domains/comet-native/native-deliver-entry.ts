import { nativeDeliverCommand } from './native-deliver-command.js';
import { runNativeScript } from './native-script-entry.js';

process.exitCode = await runNativeScript('deliver', nativeDeliverCommand);
