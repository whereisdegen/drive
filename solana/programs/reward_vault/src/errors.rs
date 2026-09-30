use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("the instructions sysvar was not supplied")]
    WrongSysvar,
    #[msg("no Ed25519 instruction at the given index")]
    MissingEd25519Ix,
    #[msg("that instruction is not the Ed25519 native program")]
    NotEd25519Program,
    #[msg("the Ed25519 instruction is malformed or carries more than one signature")]
    MalformedEd25519Ix,
    #[msg("signed by a key that is not this program's oracle")]
    WrongOracleKey,
    #[msg("the signature is over a different message than the one presented")]
    MessageMismatch,
    #[msg("that result has expired")]
    ResultExpired,
    #[msg("this day is already settled")]
    AlreadySettled,
    #[msg("the day is not over yet")]
    DayNotOver,
    #[msg("no winners were given")]
    NoWinners,
    #[msg("more winners than there are places")]
    TooManyWinners,
    #[msg("the winner and time lists are different lengths")]
    LengthMismatch,
    #[msg("the same address appears twice")]
    DuplicateWinner,
    #[msg("this day has not been settled")]
    NotSettled,
    #[msg("you did not place on this day")]
    NotAWinner,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("the 90 day claim window has closed")]
    ClaimWindowClosed,
    #[msg("the claim window is still open")]
    ClaimWindowOpen,
    #[msg("there is nothing to pay")]
    NothingToPay,
    #[msg("the wrong mint for this vault")]
    WrongMint,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("not the authority")]
    NotAuthority,
}
