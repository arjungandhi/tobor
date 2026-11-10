package dev.tobor.app.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.ui.theme.CourierPrime
import dev.tobor.app.ui.theme.ToborColors

/** Renders the supported markdown subset (see [parseMarkdown]); partial input degrades to literal text. */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = ToborColors.fg,
    fontSize: TextUnit = 14.sp,
) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        blocks.forEach { b ->
            when (b) {
                is MdBlock.Paragraph -> Text(
                    inlineString(b.inlines),
                    color = color,
                    fontFamily = CourierPrime,
                    fontSize = fontSize,
                )
                is MdBlock.Heading -> Text(
                    inlineString(b.inlines),
                    color = color,
                    fontFamily = CourierPrime,
                    fontWeight = FontWeight.Bold,
                    fontSize = when (b.level) {
                        1 -> fontSize * 1.3f
                        2 -> fontSize * 1.15f
                        else -> fontSize
                    },
                    modifier = Modifier.padding(top = 4.dp),
                )
                is MdBlock.ListItem -> Row(Modifier.padding(start = (b.level * 16).dp)) {
                    Text(
                        if (!b.ordered) (if (b.level == 0) "•" else "◦") else "${b.number}.",
                        color = ToborColors.muted,
                        fontFamily = CourierPrime,
                        fontSize = fontSize,
                        modifier = Modifier.widthIn(min = 20.dp).padding(end = 6.dp),
                    )
                    Text(
                        inlineString(b.inlines),
                        color = color,
                        fontFamily = CourierPrime,
                        fontSize = fontSize,
                        modifier = Modifier.weight(1f),
                    )
                }
                is MdBlock.CodeBlock -> Box(
                    Modifier
                        .fillMaxWidth()
                        .background(ToborColors.sunken, RoundedCornerShape(4.dp))
                        .horizontalScroll(rememberScrollState())
                        .padding(8.dp),
                ) {
                    Text(
                        b.code,
                        color = color,
                        fontFamily = FontFamily.Monospace,
                        fontSize = fontSize * 0.9f,
                        softWrap = false,
                    )
                }
            }
        }
    }
}

private val boldStyle = SpanStyle(fontWeight = FontWeight.Bold)
private val italicStyle = SpanStyle(fontStyle = FontStyle.Italic)
private val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = ToborColors.sunken)
private val linkStyles = TextLinkStyles(SpanStyle(color = ToborColors.teal, textDecoration = TextDecoration.Underline))

@Composable
private fun inlineString(inlines: List<Inline>): AnnotatedString =
    remember(inlines) { buildAnnotatedString { append(inlines) } }

private fun AnnotatedString.Builder.append(inlines: List<Inline>) {
    inlines.forEach { n ->
        when (n) {
            is Inline.Text -> append(n.text)
            is Inline.Bold -> withStyle(boldStyle) { append(n.children) }
            is Inline.Italic -> withStyle(italicStyle) { append(n.children) }
            is Inline.Code -> withStyle(codeStyle) { append(n.text) }
            is Inline.Link -> withLink(LinkAnnotation.Url(n.url, linkStyles)) { append(n.children) }
        }
    }
}
