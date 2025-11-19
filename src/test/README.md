# 🧪 Kode CLI Test Suite

> *AI-friendly testing framework that guides implementation and validates multi-model adapter architecture*

## 🎯 Overview

The Kode CLI test suite is designed as a **conversational partner** for AI agents and developers. Every test provides clear guidance on what to implement next and offers actionable feedback when things go wrong.

Our tests are designed to provide clear guidance and actionable feedback for developers working with the multi-model adapter system.

## 🏗️ Test Architecture

```
src/test/
├── testAdapters.ts              # Central model profiles & helper functions
├── unit/                        # Unit tests (mock data, fast execution)
│   ├── comprehensive-adapter-tests.test.ts  # General adapter selection & validation
│   ├── chat-completions-e2e.test.ts        # Chat Completions API-specific tests
│   └── responses-api-e2e.test.ts           # Responses API-specific tests
├── integration/                 # Integration tests (real API calls)
│   ├── integration-cli-flow.test.ts        # Full CLI workflow testing
│   └── integration-multi-turn-cli.test.ts  # Multi-turn conversation testing
├── production/                  # Production API testing
│   └── production-api-tests.test.ts        # Real API calls with credentials
└── diagnostic/                  # Diagnostic and regression tests
    ├── diagnostic-stream-test.test.ts
└── regression/
    └── responses-api-regression.test.ts
```

## 🚀 Quick Start

### Run All Tests
```bash
# Run all tests with detailed output
bun test

# Run with coverage
bun test --coverage

# Run specific test file
bun test src/test/unit/comprehensive-adapter-tests.test.ts
```

### Run Tests by Category
```bash
# Unit tests only (fast, no API calls)
bun test src/test/unit/

# Integration tests (requires API setup)
bun test src/test/integration/

# Production tests (requires real API keys)
PRODUCTION_TEST_MODE=true bun test src/test/production/
```

### Run Tests by Model/Feature
```bash
# Test specific model adapter
TEST_MODEL=gpt5 bun test
TEST_MODEL=minimax bun test
TEST_MODEL=claude-3-5-sonnet-20241022 bun test
```

## 📋 Test Categories

### 🧪 Unit Tests (`src/test/unit/`)
**Purpose**: Fast, isolated testing with mock data
- **No external API calls**
- **Mock responses** for predictable testing
- **Fast execution** for development workflow

#### Key Files:
- **`comprehensive-adapter-tests.test.ts`**: Tests adapter selection logic and basic request/response format for all models
- **`chat-completions-e2e.test.ts`**: Tests Chat Completions API-specific features (tool handling, message structure)
- **`responses-api-e2e.test.ts`**: Tests Responses API-specific features (reasoning, verbosity, streaming)

### 🔌 Integration Tests (`src/test/integration/`)
**Purpose**: End-to-end testing through the actual CLI workflow
- **Real API calls** when credentials are available
- **Complete user journeys** through claude.ts service
- **Tool calling and multi-turn conversations**

#### Key Features:
- Uses `productionTestModels` from `testAdapters.ts`
- Models are **active only when API keys are provided**
- Automatic fallback to available models

### 🏭 Production Tests (`src/test/production/`)
**Purpose**: Validate real API integrations
- **Actual API calls** to external services
- **Cost-aware**: Only runs when `PRODUCTION_TEST_MODE=true`
- **Comprehensive validation** of complete workflows

### 🔍 Diagnostic Tests (`src/test/diagnostic/`)
**Purpose**: Debugging and regression prevention
- **Stream validation** for real-time features
- **Regression testing** for known issues
- **Performance benchmarking**

## 🎯 Test Design Philosophy

### 1. Clear Separation of Concerns
Our tests are organized to minimize overlap and maximize clarity:

- **Comprehensive Tests**: General adapter functionality that applies to all models
- **API-Specific Tests**: Features unique to each API architecture
- **No Duplication**: Each behavior is tested in exactly one place

### 2. Focused, Maintainable Tests
We prioritize clarity and maintainability over verbose output:

```javascript
// Clear intent without excessive decoration
describe('Chat Completions API Tests', () => {
  test('handles Chat Completions request parameters correctly', () => {
    // Test implementation focused on specific behavior
  })
})
```

### 3. Self-Documenting Test Structure
Each test file includes comprehensive header documentation:

```javascript
/**
 * Chat Completions API Unit Tests
 *
 * Purpose: Tests Chat Completions API-specific functionality
 *
 * Focus: Features unique to Chat Completions architecture
 * - Message structure and tool handling
 * - Request/response format validation
 * - API-specific parameter handling
 */
```

## 🔧 Model Configuration

### Test Models (`testModels`)
Mock models for unit testing:
- **GPT-5 Test**: Uses Responses API adapter
- **GPT-4o Test**: Uses Chat Completions adapter
- **Claude Test**: Uses Chat Completions adapter
- And more...

### Production Models (`productionTestModels`)
Real API models for integration testing:
- **GPT-5 Production**: Requires `TEST_GPT5_API_KEY`
- **MiniMax Codex Production**: Requires `TEST_MINIMAX_API_KEY`
- **DeepSeek Production**: Requires `TEST_DEEPSEEK_API_KEY`
- **Anthropic Claude Production**: Requires `TEST_CLAUDE_API_KEY`
- **GLM Production**: Requires `TEST_GLM_API_KEY`

### Environment Variables
```bash
# API Keys (set these for integration/production tests)
TEST_GPT5_API_KEY=your-gpt5-key
TEST_MINIMAX_API_KEY=your-minimax-key
TEST_DEEPSEEK_API_KEY=your-deepseek-key
TEST_CLAUDE_API_KEY=your-claude-key
TEST_GLM_API_KEY=your-glm-key

# Optional: Custom endpoints
TEST_GPT5_BASE_URL=http://localhost:3001/openai
TEST_MINIMAX_BASE_URL=https://api.minimaxi.com/v1

# Production test mode (enables real API calls)
PRODUCTION_TEST_MODE=true
```

## 📊 Test Helper Functions

### `getChatCompletionsModels(models)`
Filters models that use Chat Completions API:
```javascript
const chatModels = getChatCompletionsModels(productionTestModels)
// Returns: [GPT-4o, Claude, MiniMax, ...]
```

### `getResponsesAPIModels(models)`
Filters models that use Responses API:
```javascript
const responsesModels = getResponsesAPIModels(productionTestModels)
// Returns: [GPT-5, ...]
```

### Model Selection Logic
```javascript
// Integration tests automatically select appropriate models:
// TEST_MODEL=gpt5 → First Responses API model
// TEST_MODEL=minimax → First Chat Completions model
// TEST_MODEL=specific-model → Exact model match
```

## 🎉 Victory Conditions

A test suite passes the **Victory Test** when:

1. **✅ Clear Purpose**: Each test file has documented intent and scope
2. **✅ No Redundancy**: Each behavior is tested exactly once
3. **✅ Focused Tests**: Tests validate specific behaviors without overlap
4. **✅ Complete Coverage**: All adapter types and API-specific features are tested
5. **✅ Environment Ready**: Tests handle setup/teardown automatically
6. **✅ Multi-Model Support**: All configured models are tested
7. **✅ Maintainable Structure**: Tests are easy to understand and modify

## 🚀 Advanced Usage

### Test Development Workflow
```bash
# 1. Start with unit tests (fast feedback)
bun test src/test/unit/

# 2. Add integration tests (workflow validation)
TEST_GPT5_API_KEY=test-key bun test src/test/integration/

# 3. Validate with production tests (real APIs)
PRODUCTION_TEST_MODE=true bun test src/test/production/

# 4. Check for regressions
bun test src/test/regression/
```

### Debugging Failed Tests
```bash
# Verbose output for debugging
bun test --verbose

# Run specific test by name pattern
bun test --grep "response"

# Stop on first failure for debugging
bun test --bail
```

## 🤝 Contributing

When adding new tests:

1. **Follow the separation of concerns**: Add general tests to comprehensive, API-specific tests to respective files
2. **Use model profiles from testAdapters.ts** for consistency
3. **Keep tests focused**: Test one specific behavior per test
4. **Include comprehensive header documentation**
5. **Test both success and failure paths**
6. **Avoid redundancy**: Check if the behavior is already tested elsewhere
7. **Ensure tests are maintainable and easy to understand**

## 📚 Related Documentation

- [`testAdapters.ts`](./testAdapters.ts) - Model configuration reference
- [`../../docs/develop-zh/architecture.md`] - Architecture documentation

---

*This test suite transforms code validation into a collaborative development experience. Every test is a conversation that guides you toward successful implementation.*