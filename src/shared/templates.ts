import type { TemplateId } from './types'

export const TEMPLATES: {
  id: TemplateId
  name: string
  tag: string
  blurb: string
  projectName: string
  brief: string
}[] = [
  {
    id: 'dense',
    name: 'Dense 7B',
    tag: 'pretrain',
    blurb: 'A 32-layer dense transformer with GQA, a full run plan from data curation to deployment.',
    projectName: 'Dense 7B',
    brief: 'A 7B dense decoder trained on 2.4T tokens, eight H100s per stage.',
  },
  {
    id: 'moe',
    name: 'MoE 8×7B',
    tag: 'sparse',
    blurb: 'Eight experts per layer with top-2 routing, a longer pretrain and a router research lane.',
    projectName: 'Atlas MoE 8×7B',
    brief: 'A sparse 8-expert model for multilingual reasoning, two experts active per token.',
  },
  {
    id: 'small',
    name: 'Small 1B eval-focused',
    tag: 'evals',
    blurb: 'A compact 1B model with a front-loaded evaluation plan and tight gate thresholds.',
    projectName: 'Lumen 1B',
    brief: 'A 1B model built to iterate quickly on evaluation coverage and gate thresholds.',
  },
  {
    id: 'blank',
    name: 'Blank project',
    tag: 'empty',
    blurb: 'An empty workspace with default run settings. Build the graph yourself.',
    projectName: 'Untitled plan',
    brief: '',
  },
]
