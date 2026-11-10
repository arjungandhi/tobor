package dev.tobor.app.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The identity mark: four sunset stripes. Use once at the top of each screen. */
@Composable
fun StripeBand(modifier: Modifier = Modifier) {
    Row(modifier = modifier.fillMaxWidth().height(6.dp)) {
        listOf(ToborColors.brown, ToborColors.stripeOrange, ToborColors.mustard, ToborColors.teal).forEach {
            Box(Modifier.weight(1f).height(6.dp).background(it))
        }
    }
}

@Composable
fun Tag(text: String, color: Color = ToborColors.fg, filled: Boolean = false) {
    val shape = RoundedCornerShape(3.dp)
    val base = Modifier.clip(shape)
    val styled = if (filled) base.background(color) else base.border(1.5.dp, color, shape)
    Text(
        text = text.uppercase(),
        modifier = styled.padding(horizontal = 6.dp, vertical = 2.dp),
        color = if (filled) ToborColors.bg else color,
        fontFamily = Righteous,
        fontSize = 9.sp,
        letterSpacing = 1.4.sp,
        maxLines = 1,
    )
}

/** Section rule: gold uppercase label followed by a line filling the rest of the row. */
@Composable
fun RuleLabel(text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = text.uppercase(),
            color = ToborColors.gold,
            fontFamily = Righteous,
            fontSize = 10.sp,
            letterSpacing = 1.6.sp,
            maxLines = 1,
        )
        Spacer(Modifier.width(8.dp))
        Box(
            Modifier
                .weight(1f)
                .height(1.5.dp)
                .background(ToborColors.gold)
        )
    }
}
