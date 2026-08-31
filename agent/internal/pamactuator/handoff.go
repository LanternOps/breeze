package pamactuator

// completeSuspendedHandoff keeps rollback armed until the receiver confirms it
// decoded and accepted the transferred suspended-process handles.
func completeSuspendedHandoff(send, awaitAcknowledgement func() error, rollback func()) error {
	if err := send(); err != nil {
		rollback()
		return err
	}
	if err := awaitAcknowledgement(); err != nil {
		rollback()
		return err
	}
	return nil
}
