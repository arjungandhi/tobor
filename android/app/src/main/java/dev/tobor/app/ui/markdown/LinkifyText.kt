package dev.tobor.app.ui.markdown

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import dev.tobor.app.ui.theme.ToborColors

private val bareUrl = Regex("""https?://\S+""")

private val linkifyStyles = TextLinkStyles(SpanStyle(color = ToborColors.teal, textDecoration = TextDecoration.Underline))

/** Plain text with bare http(s) URLs turned into tappable links; all other text is left untouched. */
fun linkifyUrls(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in bareUrl.findAll(text)) {
        val url = trimBareUrl(m.value) ?: continue
        append(text.substring(last, m.range.first))
        withLink(LinkAnnotation.Url(url, linkifyStyles)) { append(url) }
        last = m.range.first + url.length
    }
    append(text.substring(last))
}
