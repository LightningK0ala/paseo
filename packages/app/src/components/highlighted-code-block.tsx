import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownTextSpan } from "@/components/markdown-text";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { HighlightToken } from "@getpaseo/highlight";
import { isWeb } from "@/constants/platform";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { ICON_SIZE } from "@/styles/theme";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @getpaseo/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the header row sits inside the visible code area, not inside a parent
  // that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );
  const languageLabel = useMemo(() => fenceLanguageLabel(language), [language]);

  const keyedLines = useMemo<KeyedLine[] | null>(
    () => highlightToKeyedLines(renderedCode, fenceLanguageToExtension(language)),
    [renderedCode, language],
  );

  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const getCode = useCallback(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);

  return (
    <View style={containerStyle} dataSet={copyDataSet}>
      <CodeBlockHeader languageLabel={languageLabel} getCode={getCode} />
      {keyedLines ? (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {renderCodeSegments(keyedLines)}
        </MarkdownTextSpan>
      ) : (
        <MarkdownTextSpan style={innerTextStyle} copyTag="code">
          {renderedCode}
        </MarkdownTextSpan>
      )}
    </View>
  );
});

/** The fence info string's first word, as the author wrote it ("ts", "bash"). */
function fenceLanguageLabel(info: string | null | undefined): string | null {
  return info?.trim().split(/\s+/)[0] || null;
}

function renderCodeSegments(keyedLines: KeyedLine[]): React.ReactNode[] {
  const segments: React.ReactNode[] = [];
  for (let lineIndex = 0; lineIndex < keyedLines.length; lineIndex += 1) {
    const line = keyedLines[lineIndex];
    if (lineIndex > 0) {
      segments.push(<CodeTextSpan key={`${line.key}-newline`} text={"\n"} />);
    }
    for (const { key, token } of line.tokens) {
      segments.push(<TokenSpan key={`${line.key}-${key}`} token={token} />);
    }
  }
  return segments;
}

interface TokenSpanProps {
  token: HighlightToken;
}

const TokenSpan = React.memo(function TokenSpan({ token }: TokenSpanProps) {
  return (
    <MarkdownTextSpan style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
      {token.text}
    </MarkdownTextSpan>
  );
});

interface CodeTextSpanProps {
  text: string;
}

const CodeTextSpan = React.memo(function CodeTextSpan({ text }: CodeTextSpanProps) {
  return <MarkdownTextSpan>{text}</MarkdownTextSpan>;
});

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: box as ViewStyle,
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CodeBlockHeaderProps {
  languageLabel: string | null;
  getCode: () => string;
}

/**
 * Always visible, so the copy action is reachable on touch screens of any width, and
 * outside the code so it never covers the first line. The whole row is marked ignored:
 * a selection that runs through it copies neither the language nor the button label.
 */
const CodeBlockHeader = React.memo(function CodeBlockHeader({
  languageLabel,
  getCode,
}: CodeBlockHeaderProps) {
  return (
    <View
      style={codeBlockHeaderStyles.row}
      dataSet={markdownCopyDataSet.ignore}
      testID="code-block-header"
    >
      <Text style={codeBlockHeaderStyles.language} numberOfLines={1} selectable={false}>
        {languageLabel ?? ""}
      </Text>
      <CopyButton getCode={getCode} />
    </View>
  );
});

interface CopyButtonProps {
  getCode: () => string;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({ getCode }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  return (
    <Pressable
      onPress={handlePress}
      style={codeBlockHeaderStyles.button}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyCode")}
    >
      {({ hovered }) => {
        const color = hovered
          ? codeBlockHeaderStyles.foregroundHovered.color
          : codeBlockHeaderStyles.foregroundIdle.color;
        const labelStyle = hovered
          ? codeBlockHeaderStyles.buttonLabelHovered
          : codeBlockHeaderStyles.buttonLabel;
        return (
          <>
            {copied ? (
              <Check size={ICON_SIZE.xs} color={color} />
            ) : (
              <Copy size={ICON_SIZE.xs} color={color} />
            )}
            <Text style={labelStyle} selectable={false}>
              {copied ? t("message.actions.copied") : t("common.actions.copy")}
            </Text>
          </>
        );
      }}
    </Pressable>
  );
});

const codeBlockHeaderStyles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
    userSelect: "none",
    // Above the code, which is painted later: the Copy button's touch target reaches
    // past the row into the first line.
    zIndex: 1,
  },
  language: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    userSelect: "none",
  },
  // A 44pt touch target around a 14px-tall label. The negative margins give the extra
  // padding back, so the header keeps the label's height and the glyphs stay on the
  // code's right rail. Padding rather than hitSlop: react-native-web ignores hitSlop.
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 44,
    paddingVertical: 15,
    marginVertical: -13,
    paddingHorizontal: theme.spacing[2],
    marginRight: -theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  buttonLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    userSelect: "none",
  },
  buttonLabelHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    userSelect: "none",
  },
  foregroundIdle: {
    color: theme.colors.foregroundMuted,
  },
  foregroundHovered: {
    color: theme.colors.foreground,
  },
}));
