export type AriaFieldSuppression = {
  readonly tree: string
  readonly suppressed: number
}

type InputLine = {
  readonly indent: number
  readonly header: string
  readonly name: string | undefined
  readonly hasValue: boolean
}

const ARIA_ITEM = /^(\s*-\s*)(.*)$/u
const INPUT_ROLE = /^(textbox|searchbox|combobox|spinbutton)\b(.*)$/iu
const QUOTED_NAME = /^\s+("(?:[^"\\]|\\.)*")/u

function parseInputLine(line: string): InputLine | null {
  const item = ARIA_ITEM.exec(line)
  if (!item) return null
  const prefix = item[1] ?? ""
  let body = item[2] ?? ""
  let outsideValue = ""
  if (body.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?::(.*))?$/u.exec(body)
    if (!quoted) return null
    body = (quoted[1] ?? "").replaceAll("''", "'")
    outsideValue = quoted[2] ?? ""
  } else if (body.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?::(.*))?$/u.exec(body)
    if (!quoted) return null
    try {
      body = JSON.parse(quoted[1] ?? "") as string
    } catch {
      return null
    }
    outsideValue = quoted[2] ?? ""
  }
  const input = INPUT_ROLE.exec(body)
  if (!input) return null
  const role = input[1] ?? ""
  const tail = input[2] ?? ""
  const named = QUOTED_NAME.exec(tail)
  let name: string | undefined
  if (named) {
    try {
      name = JSON.parse(named[1] ?? "") as string
    } catch {
      name = undefined
    }
  }
  const value = tail.slice(named?.[0].length ?? 0).trim()
  const hasValue = (value !== "" && value !== ":") || outsideValue.trim() !== ""
  const header = `${prefix}${role}${name === undefined ? "" : ` ${JSON.stringify(name)}`}`
  return { indent: prefix.length - 2, header, name, hasValue }
}

export function suppressAriaFields(tree: string): AriaFieldSuppression {
  let suppressed = 0
  const lines = tree.split("\n")
  const safe: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const input = parseInputLine(line)
    if (!input) {
      safe.push(line)
      continue
    }
    let childEnd = index + 1
    while (childEnd < lines.length) {
      const child = lines[childEnd] ?? ""
      if (child.trim() !== "" && child.search(/\S/u) <= input.indent) break
      childEnd++
    }
    const hasChildren = childEnd > index + 1
    if (!input.hasValue && !hasChildren) {
      safe.push(line)
      continue
    }
    suppressed++
    safe.push(`${input.header}: [redacted:field]`)
    index = childEnd - 1
  }
  return { tree: safe.join("\n"), suppressed }
}
