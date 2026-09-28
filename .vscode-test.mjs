import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: '.',
	useInstallation: process.env.LOCALALOT_VSCODE_EXECUTABLE
		? { fromPath: process.env.LOCALALOT_VSCODE_EXECUTABLE }
		: undefined,
});
