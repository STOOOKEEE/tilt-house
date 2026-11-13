//! Fast-forward: simulates days of the Tilt House casino tycoon (NPC dealers, table owners, NPC
//! gamblers, LPs, the floor's seats, rent and jackpot) with the contract's rules and writes the
//! timeline as JSON for the web `/sim` page.
//!
//! Usage: `sim [--days N] [--seed S] [--out PATH]` (defaults: 7 days, seed 42, stdout).
//! `sim meme …`: the $TILT 60-day supply scenarios (`meme.rs`).

mod gamblers;
mod lps;
mod meme;
mod owners;
mod world;

use std::process::ExitCode;

const USAGE: &str = "usage: sim [--days N] [--seed S] [--out PATH]";

struct Args {
    days: u64,
    seed: u64,
    out: Option<String>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        days: 7,
        seed: 42,
        out: None,
    };
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        let number = || {
            value
                .parse::<u64>()
                .map_err(|_| format!("{flag} needs a non-negative integer, got {value:?}"))
        };
        match flag.as_str() {
            "--days" => parsed.days = number()?,
            "--seed" => parsed.seed = number()?,
            "--out" => parsed.out = Some(value),
            _ => return Err(format!("unknown argument {flag}")),
        }
    }
    if parsed.days == 0 {
        return Err("--days must be at least 1".to_string());
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let mut cli = std::env::args().skip(1).peekable();
    if cli.peek().map(String::as_str) == Some("meme") {
        return match meme::main(cli.skip(1)) {
            Ok(json) => {
                if !json.is_empty() {
                    println!("{json}");
                }
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(2)
            }
        };
    }
    let args = match parse_args(cli) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let output = world::run(args.days, args.seed);
    let json = serde_json::to_string(&output).expect("output serializes");
    let written = match &args.out {
        Some(path) => std::fs::write(path, json + "\n"),
        None => {
            println!("{json}");
            Ok(())
        }
    };
    if let Err(error) = written {
        eprintln!("cannot write output: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|a| a.to_string()))
    }

    #[test]
    fn defaults_and_flags() {
        let args = parse(&[]).unwrap();
        assert_eq!((args.days, args.seed, args.out), (7, 42, None));
        let args = parse(&["--seed", "9", "--out", "x.json", "--days", "2"]).unwrap();
        assert_eq!((args.days, args.seed), (2, 9));
        assert_eq!(args.out.as_deref(), Some("x.json"));
    }

    #[test]
    fn bad_args_are_refused() {
        assert!(parse(&["--days"]).is_err());
        assert!(parse(&["--days", "-1"]).is_err());
        assert!(parse(&["--days", "0"]).is_err());
        assert!(parse(&["--speed", "2"]).is_err());
    }
}
