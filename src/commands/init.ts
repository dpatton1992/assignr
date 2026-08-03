import {
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
	appendFileSync,
	readdirSync,
	statSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { join, relative } from 'path';
import { getPaths } from '../utils/paths.js';
import picocolors from 'picocolors';
import {
	IMPLEMENTATION_TEMPLATE,
	REVIEW_TEMPLATE,
	TEST_TEMPLATE,
} from '../templates/renderTemplate.js';
import { setupMcpConfig } from './mcpConfig.js';
import { installAssetsCommand } from './installAssets.js';

const CONFIG_YAML = `# Manciple configuration
root: .manciple
worktrees:
  enabled: true
`;

const STATE_JSON = JSON.stringify({ version: 1, tasks: [] }, null, 2);

const CORE_DOMAIN_YAML = `id: core
name: Core
description: General project work that does not belong to a more specific domain.
conventions: []
constraints: []
context: []
`;

const COMMANDS_README = `# Manciple Commands

This directory holds command reference files and local workflow notes.

## Usage

Run \`manciple --help\` to see all available commands.

## Workflow

\`\`\`bash
manciple new "My task title" --type implementation --domain core --priority high
manciple validate
manciple handoff my-task-title
# Run the generated prompt in your preferred coding agent
manciple run-log my-task-title
manciple set-status my-task-title needs_review
manciple review my-task-title
\`\`\`
`;

const ASSET_LABELS: Record<string, string> = {
	'.claude/skills': 'Claude Code skills',
	'.codex/skills': 'Codex skills',
	'.opencode/agents': 'OpenCode agents',
};

const INIT_BANNER = String.raw`        _________________________________
       /                                /|
      /   M A N C I P L E              / |
     /________________________________/  |
     |                                |  |
     |  tasks/        prompts/        |  |
     |  runs/         reviews/        |  |
     |                                |  |
     |  repo-native agent stewardship |  /
     |________________________________| /`;

interface GlobalLinkResult {
	ok: boolean;
	skipped?: boolean;
	detail?: string;
}

type LinkPackageGlobally = (packageRoot: string) => GlobalLinkResult;
type ConfirmGlobalLink = () => boolean | Promise<boolean>;

function linkPackageGlobally(packageRoot: string): GlobalLinkResult {
	const result = spawnSync('pnpm', ['link', '--global'], {
		cwd: packageRoot,
		encoding: 'utf-8',
	});

	if (result.error) {
		return { ok: false, detail: result.error.message };
	}

	if (result.status === 0) {
		return { ok: true };
	}

	const detail = (result.stderr || result.stdout || `pnpm link --global exited with status ${result.status}`).trim();
	return { ok: false, detail };
}

async function confirmGlobalLink(): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = await rl.question(
			`\n  Link this checkout globally so ${picocolors.cyan('manciple')} works on PATH? ${picocolors.dim('(y/N) ')}`,
		);
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

function updateGitignore(cwd: string, root: string, quiet: boolean = false): void {
	const gitignorePath = join(cwd, '.gitignore');
	const entriesToAdd = [`${root}/prompts/generated/`, `${root}/runs/`];
	const header = '# manciple';

	let existing = '';
	if (existsSync(gitignorePath)) {
		existing = readFileSync(gitignorePath, 'utf-8');
	}

	const missing = entriesToAdd.filter((e) => !existing.includes(e));
	if (missing.length === 0) return;

	const block = `\n${header}\n${missing.join('\n')}\n`;
	appendFileSync(gitignorePath, block, 'utf-8');

	if (!quiet) {
		const action = existing === '' ? 'Created' : 'Updated';
		console.log(
			`  ${picocolors.green('✓')} ${picocolors.dim('.gitignore')} ${action.toLowerCase()} (added ${missing.length} manciple entr${missing.length === 1 ? 'y' : 'ies'})`,
		);
	}
}

function sectionHeader(label: string): string {
	return picocolors.bold(picocolors.dim(`── ${label} ──`));
}

/**
 * Run a function with console.log suppressed.
 * Used to quietly invoke sub-commands that log their own output
 * so the init command can format a unified summary instead.
 */
function runQuietly<T>(fn: () => T): T {
	const origLog = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = origLog;
	}
}

/**
 * Recursively count files under a directory.
 */
function countFilesRecursive(dirPath: string): number {
	if (!existsSync(dirPath)) return 0;
	let count = 0;
	try {
		const entries = readdirSync(dirPath);
		for (const entry of entries) {
			const fullPath = join(dirPath, entry);
			if (statSync(fullPath).isDirectory()) {
				count += countFilesRecursive(fullPath);
			} else {
				count++;
			}
		}
	} catch {
		// skip inaccessible entries
	}
	return count;
}

// ── Init command ────────────────────────────────────────────────────────

export async function initCommand(options: {
	force: boolean;
	cwd: string;
	root: string;
	mcp?: boolean;
	agents?: boolean;
	verbose?: boolean;
	globalLink?: {
		packageRoot: string;
		linkPackageGlobally?: LinkPackageGlobally;
		confirmGlobalLink?: ConfirmGlobalLink;
	};
}): Promise<void> {
	const { force, cwd, root, mcp = false, agents = false, verbose = false, globalLink } = options;
	const runFullSetup = !mcp && !agents;
	const p = getPaths(cwd, root);

	let dirs: string[] = [];
	const created: string[] = [];
	const skipped: string[] = [];
	let globalLinkResult: GlobalLinkResult | undefined;

	// ── Execute all work first (quiet) ──────────────────────────────────

	if (runFullSetup) {
		dirs = [
			p.root,
			p.specs,
			p.specsDomains,
			p.specsContracts,
			p.tasksActive,
			p.tasksCompleted,
			p.tasksArchived,
			p.prompts,
			p.promptsTemplates,
			p.promptsGenerated,
			p.runs,
			p.state,
			p.commands,
		];

		for (const dir of dirs) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}

		const filesToCreate: Array<{ path: string; content: string }> = [
			{ path: p.config, content: CONFIG_YAML },
			{ path: `${p.specsDomains}/core.yaml`, content: CORE_DOMAIN_YAML },
			{
				path: `${p.promptsTemplates}/implementation.md`,
				content: IMPLEMENTATION_TEMPLATE,
			},
			{ path: `${p.promptsTemplates}/review.md`, content: REVIEW_TEMPLATE },
			{ path: `${p.promptsTemplates}/test.md`, content: TEST_TEMPLATE },
			{ path: p.stateFile, content: STATE_JSON },
			{ path: `${p.commands}/README.md`, content: COMMANDS_README },
		];

		for (const { path, content } of filesToCreate) {
			const isCoreDomain = path === `${p.specsDomains}/core.yaml`;
			if (existsSync(path) && (!force || isCoreDomain)) {
				skipped.push(path);
			} else {
				writeFileSync(path, content, 'utf-8');
				created.push(path);
			}
		}

		updateGitignore(cwd, root, true);
	}

	// MCP setup (quiet — output formatted later)
	if (mcp || runFullSetup) {
		runQuietly(() => setupMcpConfig(cwd, force));
	}

	// Agent assets install (quiet — output formatted later)
	if (agents || runFullSetup) {
		runQuietly(() => installAssetsCommand({ cwd, force }));
	}

	// ── 1. Branded header banner ────────────────────────────────────────

	console.log(picocolors.bold(picocolors.cyan(INIT_BANNER)));

	if (globalLink) {
		const shouldLink = await (globalLink.confirmGlobalLink ?? confirmGlobalLink)();
		if (shouldLink) {
			const linker = globalLink.linkPackageGlobally ?? linkPackageGlobally;
			globalLinkResult = linker(globalLink.packageRoot);
		} else {
			globalLinkResult = { ok: false, skipped: true };
		}
	}

	// ── 2. Success summary ──────────────────────────────────────────────

	console.log(`\n  ${sectionHeader('Setup Summary')}`);
	if (runFullSetup) {
		console.log(`  ${picocolors.green('✓')} ${picocolors.bold('Repo structure created')}`);
	}
	if (mcp || runFullSetup) {
		console.log(`  ${picocolors.green('✓')} ${picocolors.bold('MCP configured')}`);
	}
	if (agents || runFullSetup) {
		console.log(`  ${picocolors.green('✓')} ${picocolors.bold('Agent skills installed')}`);
	}
	if (globalLinkResult?.ok) {
		console.log(`  ${picocolors.green('✓')} ${picocolors.bold('CLI linked globally')}`);
	} else if (globalLinkResult?.skipped) {
		console.log(`  ${picocolors.dim('-')} ${picocolors.dim('CLI global link skipped')}`);
	} else if (globalLinkResult) {
		console.log(`  ${picocolors.yellow('!')} ${picocolors.bold('CLI global link failed')}`);
		if (globalLinkResult.detail) {
			console.log(`     ${picocolors.dim(globalLinkResult.detail.split('\n')[0])}`);
		}
	}

	// ── 3. Workflow / Next Steps ────────────────────────────────────────

	console.log(`\n  ${sectionHeader('Workflow')}`);
	console.log(`  ${picocolors.bold('1.')} Plan work:`);
	console.log(`     ${picocolors.cyan('$ manciple task new "My task" --type implementation')}`);
	console.log(`  ${picocolors.bold('2.')} Execute work:`);
	console.log(`     ${picocolors.cyan('$ manciple handoff my-task')}`);
	console.log(`  ${picocolors.bold('3.')} Review results:`);
	console.log(`     ${picocolors.cyan('$ manciple review')}`);
	console.log('');
	console.log(`  ${picocolors.dim('Using Claude Code, Codex, or OpenCode?')}`);
	console.log(`     ${picocolors.cyan('$ manciple-task-planner')}`);
	console.log(`     ${picocolors.cyan('$ manciple-agents')}`);
	console.log('');
	console.log(`  ${picocolors.dim('Need help? Run')} ${picocolors.cyan('manciple --help')}`);

	// ── 4. Detailed sections (verbose only) ─────────────────────────────

	if (verbose) {
		if (runFullSetup) {
			console.log(`\n  ${sectionHeader('Directories')}`);
			for (const dir of dirs) {
				console.log(`  ${picocolors.green('✓')} ${picocolors.bold(dir.replace(cwd + '/', '') + '/')}`);
			}

			console.log(`\n  ${sectionHeader('Files')}`);
			for (const f of created) {
				console.log(`  ${picocolors.green('✓')} ${f.replace(cwd + '/', '')}`);
			}

			if (skipped.length > 0) {
				console.log(`\n  ${picocolors.yellow('Skipped (already exist):')}`);
				for (const f of skipped) {
					console.log(`  ${picocolors.dim('-')} ${picocolors.dim(f.replace(cwd + '/', ''))}`);
				}
			}
		}

		if (mcp || runFullSetup) {
			console.log(`\n  ${sectionHeader('MCP Config')}`);
			setupMcpConfig(cwd, force);
		}

		if (agents || runFullSetup) {
			console.log(`\n  ${sectionHeader('Agent Assets')}`);
			for (const [targetPath, label] of Object.entries(ASSET_LABELS)) {
				const fullPath = join(cwd, targetPath);
				const fileCount = countFilesRecursive(fullPath);
				if (fileCount > 0) {
					console.log(`  ${picocolors.green('✓')} ${picocolors.bold(label)} (${fileCount} file${fileCount === 1 ? '' : 's'})`);
				} else {
					console.log(`  ${picocolors.dim('-')} ${picocolors.dim(label)} (not available)`);
				}
			}
		}
	}

	// ── 5. Re-run skipped note (non-verbose) ────────────────────────────

	if (!verbose && skipped.length > 0) {
		console.log(`\n  ${picocolors.dim(`${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped, use --force to overwrite`)}`);
	}

	// ── 6. Summary counts at bottom ─────────────────────────────────────

	if (runFullSetup) {
		console.log(`\n  ${picocolors.dim(`Created ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}, created ${created.length} file${created.length === 1 ? '' : 's'}`)}`);
	}
}
