package dev.tobor.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.tobor.app.R

val Righteous = FontFamily(Font(R.font.righteous, FontWeight.Normal))

val SpecialElite = FontFamily(Font(R.font.specialelite, FontWeight.Normal))

val CourierPrime = FontFamily(
    Font(R.font.courierprime, FontWeight.Normal, FontStyle.Normal),
    Font(R.font.courierprime_bold, FontWeight.Bold, FontStyle.Normal),
    Font(R.font.courierprime_italic, FontWeight.Normal, FontStyle.Italic),
)

private fun display(size: Int, line: Int) = TextStyle(
    fontFamily = Righteous,
    fontWeight = FontWeight.Normal,
    fontSize = size.sp,
    lineHeight = line.sp,
)

private fun body(size: Int) = TextStyle(
    fontFamily = CourierPrime,
    fontWeight = FontWeight.Normal,
    fontSize = size.sp,
    lineHeight = (size * 1.45f).sp,
)

val ToborTypography = Typography(
    displayLarge = display(52, 60),
    displayMedium = display(42, 50),
    displaySmall = display(34, 42),
    headlineLarge = display(30, 38),
    headlineMedium = display(26, 34),
    headlineSmall = display(22, 30),
    titleLarge = display(20, 28),
    titleMedium = display(16, 24).copy(letterSpacing = 0.02.em),
    titleSmall = display(14, 20).copy(letterSpacing = 0.02.em),
    bodyLarge = body(16),
    bodyMedium = body(14),
    bodySmall = body(12),
    labelLarge = TextStyle(
        fontFamily = Righteous,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.08.em,
    ),
    labelMedium = TextStyle(
        fontFamily = Righteous,
        fontSize = 11.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.12.em,
    ),
    labelSmall = TextStyle(
        fontFamily = Righteous,
        fontSize = 9.sp,
        lineHeight = 12.sp,
        letterSpacing = 0.16.em,
    ),
)

/** Namespace for the font families, as referenced by the screens. */
object FontFamilies {
    val Righteous: FontFamily get() = dev.tobor.app.ui.theme.Righteous
    val SpecialElite: FontFamily get() = dev.tobor.app.ui.theme.SpecialElite
    val CourierPrime: FontFamily get() = dev.tobor.app.ui.theme.CourierPrime
}

/**
 * Text style for editable text fields. Courier Prime ships lopsided win metrics
 * (winAscent 1900 vs typoAscent 1600 on a 2048 upm), which inflates the line box
 * upward and makes the cursor float above the glyphs. Pinning the line height,
 * centering it and dropping font padding keeps the cursor aligned with the text.
 */
fun fieldTextStyle(
    fontSize: TextUnit = 14.sp,
    fontFamily: FontFamily = CourierPrime,
    color: Color = Color.Unspecified,
): TextStyle = TextStyle(
    fontFamily = fontFamily,
    fontSize = fontSize,
    color = color,
    lineHeight = fontSize * 1.45f,
    lineHeightStyle = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.None,
    ),
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)
