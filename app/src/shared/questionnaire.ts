/**
 * The audit setup questions, generated from what discovery found in this
 * app rather than a fixed form (build plan, section 03). Only material
 * questions are asked, and testing a running app always needs an explicit
 * answer. The answers become the run's frozen AuditConfig.
 */

import type { AreaId, AuditConfig, Depth, Focus, StackInfo, TestMode } from './domain'
import { AREA_LABEL, DEPTH_LIMITS, FOCUS_LABEL } from './domain'

export type Answers = {
  areas: string[]
  mode: TestMode
  where: 'local' | 'url'
  url: string
  accounts: string[]
  focus: string[]
  depth: Depth
  exclude: string
  knowledge: 'yes' | 'no'
  instructions: string
}

export interface Option {
  value: string
  label: string
  hint?: string
}

export interface Question {
  id: keyof Answers
  kind: 'single' | 'multi' | 'text'
  prompt: string
  help?: string
  placeholder?: string
  options?: Option[]
  visible: (a: Answers) => boolean
}

export interface QuestionnaireInput {
  stack: StackInfo
  accounts: string[]
  /** The bundled sample is ours, so it may default to running locally. */
  trusted: boolean
  knowledgeDocs: number
}

export function buildQuestionnaire(input: QuestionnaireInput): { questions: Question[]; defaults: Answers } {
  const { stack } = input
  const always = () => true
  const testsRunningApp = (a: Answers) => a.mode !== 'white'
  const areaOptions: Option[] = [
    ...stack.areas.map((area) => ({
      value: area.id,
      label: AREA_LABEL[area.id],
      hint: `${area.files.length} file${area.files.length === 1 ? '' : 's'}, e.g. ${area.files.slice(0, 2).join(', ')}`,
    })),
    { value: 'whole_app', label: 'The whole app', hint: 'No priority; workers decide where to look.' },
  ]

  const questions: Question[] = [
    {
      id: 'areas',
      kind: 'multi',
      prompt: 'What should the audit cover?',
      help: stack.areas.length ? 'Found by reading the code. Pick the parts that matter most.' : 'Nothing stood out while reading the code.',
      options: areaOptions,
      visible: always,
    },
    {
      id: 'mode',
      kind: 'single',
      prompt: 'How may the workers test it?',
      options: [
        { value: 'white', label: 'Read the code only', hint: 'White box. Nothing is run.' },
        { value: 'black', label: 'Use the running app only', hint: 'Black box. The Researcher and Thinker do not see source code.' },
        { value: 'both', label: 'Both', hint: 'Code to find suspects, the running app to prove them.' },
      ],
      visible: always,
    },
    {
      id: 'where',
      kind: 'single',
      prompt: 'Where does the app run?',
      options: [
        {
          value: 'local',
          label: 'Start it on this Mac',
          hint: stack.commands.start ? `Runs its own scripts here (${stack.commands.start}). Only for code you trust.` : 'No start command was found; the Builder will look for one.',
        },
        { value: 'url', label: 'An authorized test URL', hint: 'Workers send read-only requests to the address you give.' },
      ],
      visible: testsRunningApp,
    },
    {
      id: 'url',
      kind: 'text',
      prompt: 'Test URL',
      help: 'Only use an address you are allowed to test. Workers cannot reach any other host.',
      placeholder: 'https://staging.example.com',
      visible: (a) => testsRunningApp(a) && a.where === 'url',
    },
    {
      id: 'accounts',
      kind: 'multi',
      prompt: 'Which test accounts may workers use?',
      help: 'Credentials stay on this Mac. Workers only see the account names.',
      options: input.accounts.map((name) => ({ value: name, label: name })),
      visible: (a) => testsRunningApp(a) && input.accounts.length > 0,
    },
    {
      id: 'focus',
      kind: 'multi',
      prompt: 'What matters most?',
      options: (Object.keys(FOCUS_LABEL) as Focus[]).map((f) => ({
        value: f,
        label: FOCUS_LABEL[f],
        hint: {
          correctness: 'Wrong results, broken rules, edge cases.',
          security: 'Access control, injection, data exposure.',
          api_contracts: 'Status codes, response shapes, validation.',
          regression: 'Turn every confirmed defect into a runnable test.',
        }[f],
      })),
      visible: always,
    },
    {
      id: 'depth',
      kind: 'single',
      prompt: 'How deep?',
      options: (['fast', 'balanced', 'deep'] as Depth[]).map((d) => ({
        value: d,
        label: d === 'fast' ? 'Fast' : d === 'balanced' ? 'Balanced' : 'Deep',
        hint: `${DEPTH_LIMITS[d].maxRounds} debate round${DEPTH_LIMITS[d].maxRounds === 1 ? '' : 's'}, up to ${DEPTH_LIMITS[d].maxClaims} findings.`,
      })),
      visible: always,
    },
    {
      id: 'knowledge',
      kind: 'single',
      prompt: 'May workers search the writeup library?',
      help: `${input.knowledgeDocs} writeups on this Mac. Retrieved notes are cited as background, never as evidence.`,
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      visible: () => input.knowledgeDocs > 0,
    },
    {
      id: 'exclude',
      kind: 'text',
      prompt: 'Anything to leave out?',
      help: 'Folders or files, separated by commas. Workers will not see them.',
      placeholder: 'docs/, vendor/, scripts/seed.js',
      visible: always,
    },
    {
      id: 'instructions',
      kind: 'text',
      prompt: 'Anything else the workers should know?',
      placeholder: 'Focus on login and payments; ignore styling; never delete data.',
      visible: always,
    },
  ]

  const detected = stack.areas.map((a) => a.id)
  const defaults: Answers = {
    areas: detected.length ? detected : ['whole_app'],
    mode: input.trusted ? 'both' : 'white',
    where: 'local',
    url: '',
    accounts: input.trusted ? [...input.accounts] : [],
    focus: ['correctness', 'security'],
    depth: 'balanced',
    exclude: stack.sensitive.join(', '),
    knowledge: input.knowledgeDocs > 0 ? 'yes' : 'no',
    instructions: '',
  }
  return { questions, defaults }
}

export interface RunSetup {
  mode: TestMode
  externalUrl: string | null
  allowCommands: boolean
  audit: AuditConfig
}

export function setupFromAnswers(a: Answers): RunSetup {
  const runsApp = a.mode !== 'white'
  const areas = a.areas.filter((x): x is AreaId | 'whole_app' => x === 'whole_app' || x in AREA_LABEL)
  return {
    mode: a.mode,
    externalUrl: runsApp && a.where === 'url' && a.url.trim() ? a.url.trim() : null,
    allowCommands: runsApp && a.where === 'local',
    audit: {
      areas: areas.length ? areas : ['whole_app'],
      focus: a.focus.filter((f): f is Focus => f in FOCUS_LABEL),
      depth: a.depth,
      excludedPaths: a.exclude
        .split(',')
        .map((p) => p.trim().replace(/^\.?\/+/, ''))
        .filter(Boolean)
        .slice(0, 40),
      accounts: runsApp ? a.accounts : [],
      useKnowledge: a.knowledge === 'yes',
      instructions: a.instructions.trim().slice(0, 2000),
    },
  }
}
