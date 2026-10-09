import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, inject, name } from '../index.mjs'
import { runtimeFixture } from './runtime-fixture.mjs'

test('Host 插件从仓库根目录注册唯一的 aico-ppt Skill', async (t) => {
  let createProvider
  let indexListener
  const disposers = []
  const services = new Map()
  const closeRuntime = async () => { for (const dispose of disposers.splice(0)) await dispose() }
  t.after(closeRuntime)
  await apply({
    skills: {
      registerProvider(factory) {
        createProvider = factory
      },
    },
    on(event, listener) {
      if (event === 'webserver/index-inject') indexListener = listener
      else assert.equal(event, 'agent/pre-step')
    },
    effect(effect) { disposers.push(effect()) },
    reflect:{ provide(name, value) { services.set(name, value); return () => services.delete(name) } },
  })
  t.after(async () => closeRuntime?.())

  const lifecycle = await services.get('aicoPptRuntime').restartStatus()
  assert.equal(lifecycle.version,services.get('aicoPptRuntime').version)
  assert.equal(lifecycle.safe,true)
  const viewDirectory = await services.get('aicoPptRuntime').views()
  assert.equal(viewDirectory.length, 1)
  assert.equal(viewDirectory[0].kind, 'app')
  assert.equal(name, 'aico-ppt')
  assert.deepEqual(inject, ['skills', 'webServer', 'tools', 'attachments'])
  assert.equal(typeof createProvider, 'function')
  const rows = []
  indexListener(rows)
  assert.equal(rows[0].kind, 'global')
  assert.equal(rows[0].name, '__AICO_PPT_BRAND__')
  assert.match(rows[0].value.logo, /^data:image\/png;base64,/u)
  assert.match(rows[0].value.appUrl, /^http:\/\/127\.0\.0\.1:\d+\/app\//u)

  const provider = createProvider()
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'aico-ppt')
  assert.equal(candidate.provider, 'aico-ppt-plugin')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, 600)
  assert.equal(candidate.path, fileURLToPath(new URL('../../../SKILL.md', import.meta.url)))
  assert.equal(candidate.resourceBase.kind, 'directory')

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'aico-ppt')
  assert.match(definition.description, /Huawei-red-brand/)
  assert.match(definition.content, /^# AICO-PPT/u)
  assert.doesNotMatch(definition.content, /^---/u)
  assert.doesNotMatch(definition.content, /integrations\/dsh\/runtime-run\.mjs/u)
})

test('配置私有运行时时保留同一 Skill 并追加模型脚本入口，清理等待 Editor 停止', async t => {
  const runtime = await runtimeFixture(t)
  let createProvider
  let indexListener
  const disposers = []
  const services = new Map()
  const closeRuntime = async () => { for (const dispose of disposers.splice(0)) await dispose() }
  t.after(closeRuntime)
  await apply({
    skills:{ registerProvider(factory) { createProvider = factory } },
    on(event, listener) { if (event === 'webserver/index-inject') indexListener = listener },
    effect(effect) { disposers.push(effect()) },
    reflect:{ provide(name, value) { services.set(name, value); return () => services.delete(name) } },
    logger:{ error(error) { assert.fail(String(error)) } },
  }, { aicoRuntime:runtime })
  t.after(() => closeRuntime?.())
  const definition = await createProvider().get({ name:'aico-ppt' })
  assert.match(definition.content, /integrations\/dsh\/runtime-run\.mjs/)
  assert.match(definition.content, /python3.*scripts\/check_deps\.py/)
  const rows = []
  indexListener(rows)
  const response = await fetch(rows[0].value.appUrl)
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  await closeRuntime()
  await assert.rejects(fetch(rows[0].value.appUrl))
})

test('Host 插件拒绝读取其他 Skill 候选', async (t) => {
  let createProvider
  const disposers = []
  const services = new Map()
  const closeRuntime = async () => { for (const dispose of disposers.splice(0)) await dispose() }
  t.after(closeRuntime)
  await apply({
    skills: { registerProvider: factory => { createProvider = factory } },
    on() {},
    effect(effect) { disposers.push(effect()) },
    reflect:{ provide(name, value) { services.set(name, value); return () => services.delete(name) } },
  })
  t.after(async () => closeRuntime?.())
  const provider = createProvider()
  assert.equal(await provider.get({ name: 'other-skill' }, {}), undefined)
})
