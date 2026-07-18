#[derive(Debug, Clone)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Object(items) => items
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, JsonValue)]> {
        match self {
            JsonValue::Object(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            JsonValue::Number(value) if value.is_finite() => Some(*value as i64),
            _ => None,
        }
    }

    pub fn truthy(&self) -> bool {
        match self {
            JsonValue::Bool(value) => *value,
            JsonValue::Number(value) => *value != 0.0,
            JsonValue::String(value) => matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "x" | "xx" | "true" | "yes" | "y" | "co" | "có" | "nghi" | "nghỉ" | "off"
            ),
            _ => false,
        }
    }
}

pub fn parse_json(input: &str) -> Result<JsonValue, String> {
    let mut parser = Parser { input, pos: 0 };
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos != input.len() {
        return Err(format!("unexpected trailing JSON at byte {}", parser.pos));
    }
    Ok(value)
}

struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'n') => self.parse_literal(b"null", JsonValue::Null),
            Some(b't') => self.parse_literal(b"true", JsonValue::Bool(true)),
            Some(b'f') => self.parse_literal(b"false", JsonValue::Bool(false)),
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(ch) => Err(format!(
                "unexpected JSON byte '{}' at {}",
                ch as char, self.pos
            )),
            None => Err("unexpected end of JSON".to_string()),
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: JsonValue) -> Result<JsonValue, String> {
        if self
            .input
            .as_bytes()
            .get(self.pos..self.pos + literal.len())
            == Some(literal)
        {
            self.pos += literal.len();
            Ok(value)
        } else {
            Err(format!("invalid literal at byte {}", self.pos))
        }
    }

    fn parse_array(&mut self) -> Result<JsonValue, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            if self.consume(b']') {
                break;
            }
            items.push(self.parse_value()?);
            self.skip_ws();
            if self.consume(b']') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(JsonValue::Array(items))
    }

    fn parse_object(&mut self) -> Result<JsonValue, String> {
        self.expect(b'{')?;
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            if self.consume(b'}') {
                break;
            }
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(b':')?;
            let value = self.parse_value()?;
            items.push((key, value));
            self.skip_ws();
            if self.consume(b'}') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(JsonValue::Object(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        while let Some(ch) = self.next_char() {
            match ch {
                '"' => return Ok(out),
                '\\' => out.push(self.parse_escape()?),
                c if c.is_control() => {
                    return Err(format!("control char in JSON string at byte {}", self.pos))
                }
                c => out.push(c),
            }
        }
        Err("unterminated JSON string".to_string())
    }

    fn parse_escape(&mut self) -> Result<char, String> {
        let Some(ch) = self.next_char() else {
            return Err("unterminated JSON escape".to_string());
        };
        match ch {
            '"' | '\\' | '/' => Ok(ch),
            'b' => Ok('\u{0008}'),
            'f' => Ok('\u{000c}'),
            'n' => Ok('\n'),
            'r' => Ok('\r'),
            't' => Ok('\t'),
            'u' => self.parse_unicode_escape(),
            _ => Err(format!("invalid JSON escape \\{ch}")),
        }
    }

    fn parse_unicode_escape(&mut self) -> Result<char, String> {
        let code = self.parse_hex4()?;
        if (0xD800..=0xDBFF).contains(&code) {
            let checkpoint = self.pos;
            if self.next_char() == Some('\\') && self.next_char() == Some('u') {
                let low = self.parse_hex4()?;
                if (0xDC00..=0xDFFF).contains(&low) {
                    let scalar = 0x10000 + (((code - 0xD800) as u32) << 10) + (low - 0xDC00) as u32;
                    return char::from_u32(scalar)
                        .ok_or_else(|| "invalid unicode scalar".to_string());
                }
            }
            self.pos = checkpoint;
        }
        char::from_u32(code as u32).ok_or_else(|| "invalid unicode escape".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        let bytes = self.input.as_bytes();
        if self.pos + 4 > bytes.len() {
            return Err("short unicode escape".to_string());
        }
        let raw = &self.input[self.pos..self.pos + 4];
        self.pos += 4;
        u16::from_str_radix(raw, 16).map_err(|_| format!("invalid unicode escape {raw}"))
    }

    fn parse_number(&mut self) -> Result<JsonValue, String> {
        let start = self.pos;
        self.consume(b'-');
        self.take_digits();
        if self.consume(b'.') {
            self.take_digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            self.take_digits();
        }
        let raw = &self.input[start..self.pos];
        let number = raw
            .parse::<f64>()
            .map_err(|_| format!("invalid number {raw}"))?;
        Ok(JsonValue::Number(number))
    }

    fn take_digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        if self.consume(expected) {
            Ok(())
        } else {
            Err(format!(
                "expected '{}' at byte {}",
                expected as char, self.pos
            ))
        }
    }

    fn consume(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.as_bytes().get(self.pos).copied()
    }

    fn next_char(&mut self) -> Option<char> {
        let rest = self.input.get(self.pos..)?;
        let ch = rest.chars().next()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }
}
