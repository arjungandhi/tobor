package dev.tobor.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.api.PendingQuestion
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.fieldTextStyle
import dev.tobor.app.ui.theme.ToborColors
import java.util.Locale

/** What the user submitted from a [QuestionCard]: one free-text answer, or one entry per form field (blank = skipped). */
sealed interface QuestionAnswer {
    data class Text(val text: String) : QuestionAnswer
    data class Form(val answers: List<String>) : QuestionAnswer
}

/**
 * An `ask_user` question as an approval-style card: question text, option chips (tapping one fills the field),
 * a free-text field (always allowed) and a submit that is disabled while blank or [busy]. When [PendingQuestion.fields]
 * is non-empty the card is a form: the header, then a labeled input (with its own chips) per field, and one submit that
 * needs at least one non-blank field. [error] is a non-fatal server message (e.g. 409 already answered).
 * [showSession] labels which session asked (the list screen needs it).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuestionCard(
    q: PendingQuestion,
    busy: Boolean,
    error: String?,
    showSession: Boolean,
    onAnswer: (QuestionAnswer) -> Unit,
) {
    val fields = q.fields.orEmpty()
    var draft by remember(q.callId) { mutableStateOf("") }
    val drafts = remember(q.callId) { mutableStateListOf<String>().apply { repeat(fields.size) { add("") } } }
    val shape = RoundedCornerShape(4.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .background(ToborColors.surface, shape)
            .border(1.dp, ToborColors.warning, shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("question", fontFamily = FontFamilies.SpecialElite, fontSize = 14.sp, color = ToborColors.warning)
        val who = buildString {
            if (showSession) append("session ").append(String.format(Locale.US, "%03d", q.sessionId))
            q.worker?.let { if (isNotEmpty()) append(" · "); append(it) }
        }
        if (who.isNotEmpty()) {
            Text(who, fontFamily = FontFamilies.CourierPrime, fontSize = 11.sp, color = ToborColors.muted)
        }
        Text(q.question, fontFamily = FontFamilies.CourierPrime, fontSize = 13.sp, color = ToborColors.fg)
        if (fields.isEmpty()) {
            AnswerInput(q.options.orEmpty(), draft, "type an answer…", busy) { draft = it }
        } else {
            fields.forEachIndexed { i, f ->
                Text(
                    f.prompt,
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 12.sp,
                    color = ToborColors.muted,
                    modifier = Modifier.padding(top = 4.dp),
                )
                AnswerInput(f.options.orEmpty(), drafts.getOrElse(i) { "" }, "skip or type an answer…", busy) {
                    if (i < drafts.size) drafts[i] = it
                }
            }
        }
        if (error != null) {
            Text(error, fontFamily = FontFamilies.CourierPrime, fontSize = 11.sp, color = ToborColors.error)
        }
        Button(
            onClick = {
                onAnswer(
                    if (fields.isEmpty()) QuestionAnswer.Text(draft.trim())
                    else QuestionAnswer.Form(drafts.map { it.trim() }),
                )
            },
            enabled = !busy && (if (fields.isEmpty()) draft.isNotBlank() else drafts.any { it.isNotBlank() }),
            modifier = Modifier.height(32.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            shape = RoundedCornerShape(4.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = ToborColors.gold,
                contentColor = ToborColors.bg,
                disabledContainerColor = ToborColors.raised,
                disabledContentColor = ToborColors.subtle,
            ),
        ) { Text("answer", fontFamily = FontFamilies.Righteous, fontSize = 12.sp) }
    }
}

/** Option chips (tapping one fills the field) above a free-text field. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AnswerInput(options: List<String>, value: String, placeholder: String, busy: Boolean, onChange: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (options.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                options.forEach { o -> AnswerChip(o, selected = value == o, enabled = !busy) { onChange(o) } }
            }
        }
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy,
            textStyle = fieldTextStyle(fontSize = 13.sp, color = ToborColors.fg),
            placeholder = {
                Text(placeholder, color = ToborColors.subtle, style = fieldTextStyle(fontSize = 13.sp))
            },
            maxLines = 4,
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = ToborColors.fg,
                unfocusedTextColor = ToborColors.fg,
                focusedBorderColor = ToborColors.gold,
                unfocusedBorderColor = ToborColors.border,
                cursorColor = ToborColors.gold,
            ),
        )
    }
}

@Composable
private fun AnswerChip(text: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    val color = if (selected) ToborColors.gold else ToborColors.muted
    Box(
        Modifier
            .clip(shape)
            .border(1.dp, if (selected) ToborColors.gold else ToborColors.border, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Text(
            text,
            fontFamily = FontFamilies.CourierPrime,
            fontSize = 12.sp,
            color = color,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
