import { test, expect, describe } from 'bun:test'
import { ModelAdapterFactory } from '../../services/modelAdapterFactory'
import { ModelProfile } from '../../utils/config'
import { testModels, getResponsesAPIModels } from '../testAdapters'

/**
 * Responses API Unit Tests
 *
 * This test file contains Responses API-specific functionality tests.
 * These tests validate Responses API-specific features and behaviors
 * that are not covered by the general adapter tests.
 */

describe('Responses API Tests', () => {

  describe('Responses API-specific functionality', () => {
    // Use a representative Responses API model for testing
    const testModel = getResponsesAPIModels(testModels)[0] || testModels[0]

    test('handles Responses API request parameters correctly', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: ['test system'],
        tools: [],
        maxTokens: 100,
        stream: false, // Even if false, Responses API always streams
        temperature: 0.7
      }

      const request = adapter.createRequest(unifiedParams)

      // Verify Responses API-specific structure
      expect(request).toHaveProperty('include')
      expect(request).toHaveProperty('max_output_tokens')
      expect(request).toHaveProperty('input')
      expect(request.stream).toBe(true) // Responses API always streams

      // Should NOT have Chat Completions fields
      expect(request).not.toHaveProperty('messages')
      expect(request).not.toHaveProperty('max_tokens')
      expect(request).not.toHaveProperty('max_completion_tokens')
    })

    test('parses Responses API response format correctly', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const mockResponseData = {
        id: 'resp-test-123',
        object: 'response',
        created: Date.now(),
        model: testModel.modelName,
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Mock response for Responses API'
          }]
        }],
        usage: {
          input_tokens: 15,
          output_tokens: 25,
          total_tokens: 40
        }
      }

      const unifiedResponse = await adapter.parseResponse(mockResponseData)

      expect(unifiedResponse).toBeDefined()
      expect(unifiedResponse.id).toBe('resp-test-123')
      // Responses API returns content as array
      expect(Array.isArray(unifiedResponse.content)).toBe(true)
      expect(unifiedResponse.content.length).toBe(1)
      expect(unifiedResponse.content[0]).toHaveProperty('type', 'text')
      expect(unifiedResponse.content[0]).toHaveProperty('text', 'Mock response for Responses API')
      expect(unifiedResponse.toolCalls).toBeDefined()
      expect(Array.isArray(unifiedResponse.toolCalls)).toBe(true)
      expect(unifiedResponse.toolCalls.length).toBe(0)
    })

    test('includes reasoning and verbosity parameters when provided', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'Explain this code' }
        ],
        systemPrompt: ['You are an expert'],
        maxTokens: 200,
        reasoningEffort: 'high' as const,
        verbosity: 'high' as const,
      }

      const request = adapter.createRequest(unifiedParams)

      expect(request.reasoning).toBeDefined()
      expect(request.reasoning.effort).toBe('high')
      expect(request.text).toBeDefined()
      expect(request.text.verbosity).toBe('high')
    })

    test('converts tool results to function_call_output format', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'What is this file?' },
          {
            role: 'tool',
            tool_call_id: 'tool_123',
            content: 'This is a TypeScript file'
          },
          { role: 'user', content: 'Please read it' }
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      }

      const request = adapter.createRequest(unifiedParams)

      // Should have input array with function_call_output
      expect(request.input).toBeDefined()
      expect(Array.isArray(request.input)).toBe(true)

      // Should have function call result
      const hasFunctionCallOutput = request.input.some((item: any) => item.type === 'function_call_output')
      expect(hasFunctionCallOutput).toBe(true)
    })

  })

  describe('Responses API unique behaviors', () => {
    // Use a representative Responses API model for testing
    const testModel = getResponsesAPIModels(testModels)[0] || testModels[0]

    test('joins multiple system prompts with double newlines', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'Hello' }
        ],
        systemPrompt: [
          'You are a coding assistant',
          'Always write clean code'
        ],
        maxTokens: 50,
      }

      const request = adapter.createRequest(unifiedParams)

      // System prompts should be joined with double newlines
      expect(request.instructions).toBe('You are a coding assistant\n\nAlways write clean code')
    })

    test('always enables streaming regardless of stream parameter', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'Hello' }
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
        stream: false, // Even if user sets this to false
      }

      const request = adapter.createRequest(unifiedParams)

      // Responses API always requires streaming
      expect(request.stream).toBe(true)
    })

  })
})
