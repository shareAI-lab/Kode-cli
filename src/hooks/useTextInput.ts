import { useState } from 'react'
import { type Key } from 'ink'
import { useDoublePress } from './useDoublePress'
import { Cursor } from '@utils/Cursor'
import {
  getImageFromClipboard,
  CLIPBOARD_ERROR_MESSAGE,
} from '@utils/imagePaste'

const IMAGE_PLACEHOLDER = '[Image pasted]'

type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  return function (input: string): MaybeCursor {
    const handler = new Map(input_map).get(input) ?? (() => {})
    return handler(input)
  }
}

type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onMessage?: (show: boolean, message?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (base64Image: string) => void
  disableCursorMovementForUpDownKeys?: boolean
  externalOffset: number
  onOffsetChange: (offset: number) => void
}

type UseTextInputResult = {
  renderedValue: string
  onInput: (input: string, key: Key) => void
  offset: number
  setOffset: (offset: number) => void
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  externalOffset,
  onOffsetChange,
}: UseTextInputProps): UseTextInputResult {
  const offset = externalOffset
  const setOffset = onOffsetChange
  const cursor = Cursor.fromText(originalValue, columns, offset)
  const [imagePasteErrorTimeout, setImagePasteErrorTimeout] =
    useState<NodeJS.Timeout | null>(null)

  function maybeClearImagePasteErrorTimeout() {
    if (!imagePasteErrorTimeout) {
      return
    }
    clearTimeout(imagePasteErrorTimeout)
    setImagePasteErrorTimeout(null)
    onMessage?.(false)
  }

  const handleCtrlC = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        onHistoryReset?.()
      }
    },
  )

  // Keep Escape for clearing input
  const handleEscape = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onMessage?.(!!originalValue && show, `Press Escape again to clear`)
    },
    () => {
      if (originalValue) {
        onChange('')
      }
    },
  )
  function clear() {
    return Cursor.fromText('', columns, 0)
  }

  const handleEmptyCtrlD = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-D'),
    () => onExit?.(),
  )

  function handleCtrlD(): MaybeCursor {
    maybeClearImagePasteErrorTimeout()
    if (cursor.text === '') {
      // When input is empty, handle double-press
      handleEmptyCtrlD()
      return cursor
    }
    // When input is not empty, delete forward like iPython
    return cursor.del()
  }

  function tryImagePaste() {
    // For text inputs with masks (like API keys), don't try to process as image
    // Let the system handle normal paste operations
    if (mask) {
      // Return cursor unchanged - let the default paste handler work
      return cursor
    }

    const base64Image = getImageFromClipboard()
    if (base64Image === null) {
      if (process.platform !== 'darwin') {
        return cursor
      }
      onMessage?.(true, CLIPBOARD_ERROR_MESSAGE)
      maybeClearImagePasteErrorTimeout()
      setImagePasteErrorTimeout(
        setTimeout(() => {
          onMessage?.(false)
        }, 4000),
      )
      return cursor
    }

    onImagePaste?.(base64Image)
    return cursor.insert(IMAGE_PLACEHOLDER)
  }

  const handleCtrl = mapInput([
    ['a', () => cursor.startOfLine()],
    ['b', () => cursor.left()],
    ['c', handleCtrlC],
    ['d', handleCtrlD],
    ['e', () => cursor.endOfLine()],
    ['f', () => cursor.right()],
    [
      'h',
      () => {
        maybeClearImagePasteErrorTimeout()
        return cursor.backspace()
      },
    ],
    ['k', () => cursor.deleteToLineEnd()],
    ['l', () => clear()],
    ['n', () => downOrHistoryDown()],
    ['p', () => upOrHistoryUp()],
    ['u', () => cursor.deleteToLineStart()],
    ['v', tryImagePaste],
    ['w', () => cursor.deleteWordBefore()],
  ])

  const handleMeta = mapInput([
    ['b', () => cursor.prevWord()],
    ['f', () => cursor.nextWord()],
    ['d', () => cursor.deleteWordAfter()],
  ])

  function handleEnter(key: Key) {
    if (
      multiline &&
      cursor.offset > 0 &&
      cursor.text[cursor.offset - 1] === '\\'
    ) {
      return cursor.backspace().insert('\n')
    }
    // Support Option+Enter for newline
    if ('option' in key && key.option) {
      return cursor.insert('\n')
    }
    onSubmit?.(originalValue)
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return cursor
    }
    const cursorUp = cursor.up()
    if (cursorUp.equals(cursor)) {
      // already at beginning
      onHistoryUp?.()
    }
    return cursorUp
  }
  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return cursor
    }
    const cursorDown = cursor.down()
    if (cursorDown.equals(cursor)) {
      onHistoryDown?.()
    }
    return cursorDown
  }

  function onInput(input: string, key: Key): void {
    if (key.tab) {
      return // Skip Tab key processing - let completion system handle it
    }

    // Direct handling for backspace or delete (which is being detected as delete)
    if (
      key.backspace ||
      key.delete ||
      input === '\b' ||
      input === '\x7f' ||
      input === '\x08'
    ) {
      const nextCursor = cursor.backspace()
      if (!cursor.equals(nextCursor)) {
        setOffset(nextCursor.offset)
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
      }
      return
    }

    // Handle paste operations - process large input strings more efficiently
    // This prevents cursor position issues when pasting into masked fields
    if (!key.ctrl && !key.meta && input.length > 1) {
      // Likely a paste operation
      const nextCursor = cursor.insert(input)
      if (!cursor.equals(nextCursor)) {
        setOffset(nextCursor.offset)
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
      }
      return
    }

    const nextCursor = mapKey(key)(input)
    if (nextCursor) {
      if (!cursor.equals(nextCursor)) {
        setOffset(nextCursor.offset)
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
      }
    }
  }

  function mapKey(key: Key): InputMapper {
    // Direct handling for backspace or delete
    if (key.backspace || key.delete) {
      maybeClearImagePasteErrorTimeout()
      return () => cursor.backspace()
    }

    switch (true) {
      case key.escape:
        return handleEscape
      case key.leftArrow && (key.ctrl || key.meta || ('fn' in key && key.fn)):
        return () => cursor.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || ('fn' in key && key.fn)):
        return () => cursor.nextWord()
      case key.ctrl:
        return handleCtrl
      case 'home' in key && key.home:
        return () => cursor.startOfLine()
      case 'end' in key && key.end:
        return () => cursor.endOfLine()
      case key.pageDown:
        return () => cursor.endOfLine()
      case key.pageUp:
        return () => cursor.startOfLine()
      case key.meta:
        return handleMeta
      case key.return:
        return () => handleEnter(key)
      // Remove Tab handling - let completion system handle it
      case key.upArrow:
        return upOrHistoryUp
      case key.downArrow:
        return downOrHistoryDown
      case key.leftArrow:
        return () => cursor.left()
      case key.rightArrow:
        return () => cursor.right()
    }
    return function (input: string) {
      switch (true) {
        // Home key
        case input == '\x1b[H' || input == '\x1b[1~':
          return cursor.startOfLine()
        // End key
        case input == '\x1b[F' || input == '\x1b[4~':
          return cursor.endOfLine()
        // Handle backspace character explicitly - this is the key fix
        case input === '\b' || input === '\x7f' || input === '\x08':
          maybeClearImagePasteErrorTimeout()
          return cursor.backspace()
        default:
          return cursor.insert(input.replace(/\r/g, '\n'))
      }
    }
  }

  return {
    onInput,
    renderedValue: cursor.render(cursorChar, mask, invert),
    offset,
    setOffset,
  }
}
