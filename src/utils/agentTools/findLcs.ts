/**
 * Find longest common subsequence of symbols
 * Integrated from AgentTool
 *
 * Uses dynamic programming approach.
 * Finds the most optimal solution where the index difference
 * for each match between the two sequences is at most maxIndexDiff.
 *
 * Time and memory complexity: O(N * K)
 * where N is the length of sequence A
 * and K is the maxIndexDiff
 *
 * @param symbolsA - First sequence
 * @param symbolsB - Second sequence
 * @param maxIndexDiff - Maximum index difference allowed
 * @returns mapping from index in symbolsA to index in symbolsB, or -1 if not mapped
 */
export function findLongestCommonSubsequence(
  symbolsA: string[],
  symbolsB: string[],
  maxIndexDiff: number = 100
): number[] {
  const n = symbolsA.length
  const m = symbolsB.length

  // Initialize the mapping array with -1 (not mapped)
  const mapping: number[] = Array.from<number>({ length: n }).fill(-1)

  if (n === 0 || m === 0) {
    return mapping
  }

  // Create a 2D array to store the length of LCS
  // We only need to store values for indices within maxIndexDiff
  // For each i, we store values for j where |i-j| <= maxIndexDiff
  const dp: number[][] = Array.from<number[]>({ length: n + 1 })
    .fill([])
    .map(() => Array.from<number>({ length: 2 * maxIndexDiff + 1 }).fill(0))

  // Store the move direction as [di, dj] tuples for backtracking
  type Move = [number, number] // [di, dj] where di and dj are the changes in i and j
  const moves: Move[][] = Array.from<Move[]>({ length: n + 1 })
    .fill([])
    .map(() => Array.from<Move>({ length: 2 * maxIndexDiff + 1 }).fill([0, 0]))

  // Fill the dp table
  for (let i = 1; i <= n; i++) {
    const minJ = Math.max(1, i - maxIndexDiff)
    const maxJ = Math.min(m, i + maxIndexDiff)

    for (let j = minJ; j <= maxJ; j++) {
      // Convert actual j to shifted j index in our dp array
      const shiftedJ = j - (i - maxIndexDiff)

      if (symbolsA[i - 1] === symbolsB[j - 1]) {
        // If symbols match, extend the previous LCS
        const prevI = i - 1
        const prevJ = j - 1

        // Check if prevJ is within bounds for prevI
        if (
          prevJ >= Math.max(1, prevI - maxIndexDiff) &&
          prevJ <= Math.min(m, prevI + maxIndexDiff)
        ) {
          const prevShiftedJ = prevJ - (prevI - maxIndexDiff)
          dp[i][shiftedJ] = dp[prevI][prevShiftedJ] + 1
          moves[i][shiftedJ] = [-1, -1] // Diagonal move (match): go up and left
        } else {
          dp[i][shiftedJ] = 1
          moves[i][shiftedJ] = [-1, -1] // Diagonal move for first match
        }
      } else {
        // If symbols don't match, take the maximum of left and up
        let leftValue = 0
        let upValue = 0

        // Check left (i, j-1)
        if (j - 1 >= minJ) {
          leftValue = dp[i][shiftedJ - 1]
        }

        // Check up (i-1, j)
        const prevI = i - 1
        if (j >= Math.max(1, prevI - maxIndexDiff) && j <= Math.min(m, prevI + maxIndexDiff)) {
          const prevShiftedJ = j - (prevI - maxIndexDiff)
          upValue = dp[prevI][prevShiftedJ]
        }

        if (leftValue >= upValue) {
          dp[i][shiftedJ] = leftValue
          moves[i][shiftedJ] = [0, -1] // Left move: stay in same row, go left
        } else {
          dp[i][shiftedJ] = upValue
          moves[i][shiftedJ] = [-1, 0] // Up move: go up, stay in same column
        }
      }
    }
  }

  // Backtrack to find the mapping
  let i = n
  let j = m

  // Find the end position with maximum LCS length
  // We only need to check the last row (i == n) since it contains
  // the complete information about the longest subsequences
  let maxLength = 0
  let maxJPos = m

  // Only need to check the last row (i == n)
  const minJ = Math.max(1, n - maxIndexDiff)
  const maxJ = Math.min(m, n + maxIndexDiff)

  for (let jCheck = minJ; jCheck <= maxJ; jCheck++) {
    const shiftedJ = jCheck - (n - maxIndexDiff)
    if (dp[n][shiftedJ] > maxLength) {
      maxLength = dp[n][shiftedJ]
      maxJPos = jCheck
    }
  }

  // Start backtracking from the maximum position
  i = n
  j = maxJPos

  while (i > 0 && j > 0) {
    const shiftedJ = j - (i - maxIndexDiff)

    // Check if shiftedJ is within bounds
    if (shiftedJ < 0 || shiftedJ >= 2 * maxIndexDiff + 1) {
      break
    }

    const [di, dj] = moves[i][shiftedJ]

    if (di === -1 && dj === -1) {
      // Diagonal move (match)
      mapping[i - 1] = j - 1 // Store the mapping
    }

    // Apply the move
    i += di
    j += dj

    // If no move is recorded (both di and dj are 0), break
    if (di === 0 && dj === 0) {
      break
    }
  }

  return mapping
}
