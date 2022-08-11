import fsPromises from 'fs/promises'
import path from 'path'
import log from 'electron-log'
import iconv from 'iconv-lite'
import { LINE_ENDING_REG, LF_LINE_ENDING_REG, CRLF_LINE_ENDING_REG } from '../config'
import { isDirectory2 } from 'common/filesystem'
import { isMarkdownFile } from 'common/filesystem/paths'
import { normalizeAndResolvePath, writeFile } from '../filesystem'
import { guessEncoding } from './encoding'

const getLineEnding = lineEnding => {
  if (lineEnding === 'lf') {
    return '\n'
  } else if (lineEnding === 'crlf') {
    return '\r\n'
  }

  // This should not happend but use fallback value.
  //这不应该发生，而应该使用回退值。
  log.error(`Invalid end of line character: expected "lf" or "crlf" but got "${lineEnding}".`)
  return '\n'
}

const convertLineEndings = (text, lineEnding) => {
  return text.replace(LINE_ENDING_REG, getLineEnding(lineEnding))
}

/**
 * Special function to normalize directory and markdown file paths.
 * 用于规范目录和标记文件路径的特殊函数。
 *
 * @param {string} pathname The path to the file or directory.
 * @returns {{isDir: boolean, path: string}?} Returns the normalize path and a
 * directory hint or null if it's not a directory or markdown file.
 * @param{string}pathname文件或目录的路径。
 * @返回{isDir:boolean，路径：string}？}返回规范化路径和
 * 如果不是目录或标记文件，则为目录提示或null。
 */
export const normalizeMarkdownPath = pathname => {
  const isDir = isDirectory2(pathname)
  if (isDir || isMarkdownFile(pathname)) {
    // Normalize and resolve the path or link target.
    // 规范化并解析路径或链接目标。
    const resolved = normalizeAndResolvePath(pathname)
    if (resolved) {
      return { isDir, path: resolved }
    } else {
      console.error(`[ERROR] Cannot resolve "${pathname}".`)
    }
  }
  return null
}

/**
 * Write the content into a file.
 *
 * @param {string} pathname The path to the file.
 * @param {string} content The buffer to save.
 * @param {IMarkdownDocumentOptions} options The markdown document options
  *将内容写入文件。
  *@param{string}pathname文件的路径。
  *@param{string}包含要保存的缓冲区。
  *@param{IMarkdownDocumentOptions}选项标记文档选项
 */

export const writeMarkdownFile = (pathname, content, options) => {
  const { adjustLineEndingOnSave, lineEnding } = options
  const { encoding, isBom } = options.encoding
  const extension = path.extname(pathname) || '.md'

  if (adjustLineEndingOnSave) {
    content = convertLineEndings(content, lineEnding)
  }

  const buffer = iconv.encode(content, encoding, { addBOM: isBom })

  // TODO(@fxha): "safeSaveDocuments" using temporary file and rename syscall.
  //TODO（@fxha）：“safeSaveDocuments”使用临时文件并重命名系统调用。
  return writeFile(pathname, buffer, extension, undefined)
}

/**
 * Reads the contents of a markdown file.
 *
 * @param {string} pathname The path to the markdown file.
 * @param {string} preferredEol The preferred EOL.
 * @param {boolean} autoGuessEncoding Whether we should try to auto guess encoding.
 * @param {*} trimTrailingNewline The trim trailing newline option.
 * @returns {IMarkdownDocumentRaw} Returns a raw markdown document.
*读取标记文件的内容。
*@param{string}pathname标记文件的路径。
*@param｛string｝首选EOL。
*@param{boolean}自动猜测编码我们是否应该尝试自动猜测编码。
*@param｛*｝trimTrailingNewline：修剪尾部新行选项。
*@returns｛IMarkdownDocumentRaw｝返回原始的markdown文档。
 */
export const loadMarkdownFile = async (pathname, preferredEol, autoGuessEncoding = true, trimTrailingNewline = 2) => {
  // TODO: Use streams to not buffer the file multiple times and only guess
  //       encoding on the first 256/512 bytes.
  //TODO:使用流不多次缓冲文件，只进行猜测
  //对前256/512字节进行编码。

  let buffer = await fsPromises.readFile(path.resolve(pathname))

  const encoding = guessEncoding(buffer, autoGuessEncoding)
  const supported = iconv.encodingExists(encoding.encoding)
  if (!supported) {
    throw new Error(`"${encoding.encoding}" encoding is not supported.`)
  }

  let markdown = iconv.decode(buffer, encoding.encoding)

  // Detect line ending
  //检测行尾
  const isLf = LF_LINE_ENDING_REG.test(markdown)
  const isCrlf = CRLF_LINE_ENDING_REG.test(markdown)
  const isMixedLineEndings = isLf && isCrlf
  const isUnknownEnding = !isLf && !isCrlf
  let lineEnding = preferredEol
  if (isLf && !isCrlf) {
    lineEnding = 'lf'
  } else if (isCrlf && !isLf) {
    lineEnding = 'crlf'
  }

  let adjustLineEndingOnSave = false
  if (isMixedLineEndings || isUnknownEnding || lineEnding !== 'lf') {
    adjustLineEndingOnSave = lineEnding !== 'lf'
    // Convert to LF for internal use.
    //转换为LF供内部使用。
    markdown = convertLineEndings(markdown, 'lf')
  }

  // Detect final newline
  //检测最终换行
  if (trimTrailingNewline === 2) {
    if (!markdown) {
      // Use default value
      //使用默认值
      trimTrailingNewline = 3
    } else {
      const lastIndex = markdown.length - 1
      if (lastIndex >= 1 && markdown[lastIndex] === '\n' && markdown[lastIndex - 1] === '\n') {
        // Disabled
        trimTrailingNewline = 2
      } else if (markdown[lastIndex] === '\n') {
        // Ensure single trailing newline
        //确保单个尾随换行符
        trimTrailingNewline = 1
      } else {
        // Trim trailing newlines
        //修剪尾部换行符
        trimTrailingNewline = 0
      }
    }
  }

  const filename = path.basename(pathname)
  return {
    // document information
    //文件信息
    markdown,
    filename,
    pathname,

    // options
    encoding,
    lineEnding,
    adjustLineEndingOnSave,
    trimTrailingNewline,

    // raw file information
    isMixedLineEndings
  }
}
