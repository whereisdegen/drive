use anchor_lang::prelude::*;

#[error_code]
pub enum RaceError {
    // ---- attestation
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
    #[msg("that attestation belongs to a different driver")]
    WrongDriver,
    #[msg("that time was set on a different track")]
    WrongTrack,
    #[msg("that attestation has expired - drive it again")]
    AttestationExpired,
    #[msg("that run has already been used")]
    NonceSpent,
    #[msg("you have to set the time AFTER taking the challenge")]
    StaleRun,

    // ---- duels and pots
    #[msg("stake something more than zero")]
    ZeroStake,
    #[msg("that deadline is out of range")]
    BadWindow,
    #[msg("this contest is not in a state where that works")]
    BadState,
    #[msg("too early - the window has not closed")]
    NotYet,
    #[msg("too late - the window has closed")]
    TooLate,
    #[msg("you are not in this contest")]
    NotParticipant,
    #[msg("you have already entered")]
    AlreadyEntered,
    #[msg("enter the pot first")]
    NotEntered,
    #[msg("you cannot duel yourself")]
    SelfDuel,
    #[msg("that fee is above the cap")]
    FeeTooHigh,
    #[msg("the wrong mint for this contest")]
    WrongMint,
    #[msg("the wrong treasury account")]
    WrongTreasury,
    #[msg("the token transferred in did not match the amount requested")]
    FeeOnTransferToken,
    #[msg("arithmetic overflow")]
    Overflow,
}
