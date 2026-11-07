import { expect, test } from 'vitest'
import { prettyModel, shortModelName } from './modelName'

test('已知模型与 Claude 家族名的友好展示', () => {
  expect(prettyModel('claude-sonnet-4-5')).toBe('Claude Sonnet 4.5')
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Claude Sonnet 3.5')
  expect(prettyModel('claude-opus-4-1')).toBe('Claude Opus 4.1')
  expect(prettyModel('gpt-5')).toBe('GPT-5')
  expect(prettyModel('gemini-2.5-pro')).toBe('Gemini 2.5 Pro')
})

test('未知模型去掉版本日期并把连字符转空格', () => {
  expect(prettyModel('qwen-max')).toBe('Qwen Max')
  expect(prettyModel('my-model-20260101')).toBe('My Model')
  expect(prettyModel('')).toBe('选择模型')
})

test('手机端短名去掉 Claude 前缀', () => {
  expect(shortModelName('claude-sonnet-4-5')).toBe('Sonnet 4.5')
  expect(shortModelName('gpt-5')).toBe('GPT-5')
})
